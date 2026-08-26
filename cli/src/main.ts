/**
 * cli/src/main.ts — the pmcp command surface (§10): argv in, exit code out.
 *
 * This module OWNS the CLI's presentation layer: the argv grammar (command and
 * flag spelling, `--json` vs `key=value` tool arguments, the `<slug>_<tool>`
 * aggregated-name split), the config file (`~/.config/pmcp/config.toml` — named
 * profiles, each one hub identity), which profile is ACTIVE (`--profile` >
 * PMCP_PROFILE > the file's `profile` key > `default`) and the flat PMCP_URL /
 * PMCP_TOKEN override order on top of it,
 * every table/plan/confirmation rendering and exit-code decision, and the
 * CLI's copies of the pinned wire shapes below. It HIDES the transport:
 * every command except the auth family is presentation sugar over MCP
 * tools/call through the official MCP client (@modelcontextprotocol/client —
 * implementation-time only, never imported here), so no command is a
 * capability an agent holding the same token lacks (§8's parity invariant —
 * only the UX differs). plan.ts stays pure: this module performs all I/O —
 * file reads, tool calls, prompts — and hands the planner plain data. Grants
 * have no imperative family on purpose: they are managed declaratively via
 * diff/apply, or through `pmcp call pmcp grant_set` like any other tool.
 *
 * ponytail: the "official MCP client" is not installed and no dependency may be
 * added (§4 pins better-auth as the only one), so the two seams below speak the
 * hub's stateless POST endpoint with `fetch` — one JSON-RPC message per request,
 * exactly what §7 serves. Swap them for the SDK client the day it is a dependency;
 * nothing above them knows the difference.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The extension is spelled out so `node --experimental-strip-types cli/src/main.ts` can
// resolve it — Node's own type stripping resolves a relative import only WITH one.
import { COMMANDS as COMMAND_TABLE } from "./commands.ts";
import { parseDesired, planChanges } from "./plan.ts";
import type { CurrentAccount, CurrentService, CurrentState, DesiredGrant, Plan } from "./plan.ts";
import { emitToml, parseToml } from "./toml.ts";
import type { PmcpConfig, PmcpProfile } from "./toml.ts";
import { parseYaml } from "./yaml.ts";

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
 * COPIED wire shape — one `service_list` / `service_get` row (§8's pinned cross-front
 * shape, the server's own `ServiceRow`; contracts/service-list.json is the lock).
 * Deliberately duplicated (no shared package) and deliberately FLAT where the server's is
 * a discriminated union: the CLI branches on `kind` at runtime, so the per-kind fields are
 * optional here rather than three types. Declared once so `ls`, `account`, and the diff
 * planner's read share one decoding instead of three private ones — a field renamed
 * server-side then fails to compile here rather than emptying a column.
 */
export type ServiceRow = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  logBodies: boolean;
  roles: Record<string, string[]>;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
  kind: "tunnel" | "proxy" | "builtin";
  /** builtin rows only — the virtual `pmcp` service, which the planner never plans against */
  builtin?: boolean;
  /** tunneled rows only */
  status?: "online" | "offline";
  /** proxied rows only */
  endpoint?: string;
  auth?: "headers" | "oauth";
  forwardIdentity?: boolean;
  /** proxied `auth: oauth` rows only — the upstream connection state */
  connection?: string;
};

/**
 * COPIED wire shape — one `account_list` row, grants inline as the flat
 * `role[:approval]` strings `grant_set` takes (§8 pins that there is no separate
 * grant-read tool; contracts/account-list.json is the lock).
 */
export type AccountRow = {
  slug: string;
  name: string;
  description: string;
  grants: Record<string, string[]>;
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
    this.code = code;
    this.data = data;
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

/** Where the profiles live between invocations (§10). */
function configPath(): string {
  return join(homedir(), ".config", "pmcp", "config.toml");
}

/**
 * The file as it was before profiles: one flat `{ url, token }`. Read once as profile
 * `default` and superseded by the next write (§10) — never rewritten, never deleted, so a
 * downgrade still finds the session it left behind.
 */
function legacyConfigPath(): string {
  return join(homedir(), ".config", "pmcp", "config.json");
}

function readConfig(): PmcpConfig {
  // A malformed config.toml is NOT swallowed: parseToml names the line, and main's handler
  // prints it. Silently resolving to "not logged in" would send the user to `pmcp login`
  // for a typo three lines up. The legacy json is best-effort — it is on its way out.
  if (existsSync(configPath())) return parseToml(readFileSync(configPath(), "utf8"));
  if (!existsSync(legacyConfigPath())) return { profiles: {} };
  try {
    const flat = JSON.parse(readFileSync(legacyConfigPath(), "utf8")) as { url?: string; token?: string };
    return {
      profile: "default",
      profiles: {
        default: { ...(flat.url === undefined ? {} : { url: flat.url }), ...(flat.token === undefined ? {} : { token: flat.token }) },
      },
    };
  } catch {
    return { profiles: {} };
  }
}

function writeConfig(config: PmcpConfig): void {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  // 0600: the file holds a live session bearer — one per profile.
  writeFileSync(path, emitToml(config), { mode: 0o600 });
}

/**
 * Which profile this invocation acts on: the `--profile` flag, else PMCP_PROFILE, else the
 * file's own top-level `profile`, else the name `default` — neutral on purpose, since the
 * CLI's users are not only developers with environments (§10).
 */
function activeProfile(config: PmcpConfig, flag?: string): string {
  return flag ?? process.env.PMCP_PROFILE ?? config.profile ?? "default";
}

/** The active profile's stored values — `{}` when the file has no table by that name. */
function profileOf(config: PmcpConfig, name: string): PmcpProfile {
  return config.profiles[name] ?? {};
}

/**
 * The `pnpm users` bridge, called by scripts/users.mts: consumes a leading
 * `--profile <name>`, fills PMCP_URL and BOOTSTRAP_SECRET from that profile wherever the
 * environment has not already spoken, and returns the rest of argv. It lives here because
 * the precedence lives here — scripts/users.ts stays env-only, which is its tested
 * contract (§12), and gains a config file it never reads.
 */
export function applyProfile(argv: string[]): string[] {
  // deps: readConfig · node:process
  const rest = [...argv];
  const flag = rest[0] === "--profile" ? rest.splice(0, 2)[1] : undefined;
  const config = readConfig();
  const profile = profileOf(config, activeProfile(config, flag));
  for (const [variable, key] of [["PMCP_URL", "url"], ["BOOTSTRAP_SECRET", "bootstrap_secret"]] as const) {
    // The environment wins where it is already set; an empty value is not set (users.ts
    // reads it the same way), and `undefined` is never assigned — process.env would spell
    // it as the string "undefined".
    if ((process.env[variable] ?? "") === "" && (profile[key] ?? "") !== "") process.env[variable] = profile[key];
  }
  return rest;
}

/**
 * Builds the per-invocation context: the ACTIVE profile's stored url/token overlaid
 * by the flat PMCP_URL / PMCP_TOKEN (the environment is profile-free, §10), then one
 * GET /api/whoami to learn principal and namespace (§10 — this is how a service-account
 * key learns whose namespace it lives in). A `pmcp_svc_`-prefixed token is refused here
 * with a clear message — every consumer surface rejects service tokens, so failing early
 * beats a confusing server 401; no token at all fails with a "run pmcp login" hint that
 * names the profile, since a `--profile` typo and an expired session look identical
 * otherwise.
 */
async function resolveContext(profileName?: string): Promise<CliContext> {
  // deps: node:fs · node:os · node:process · fetch GET /api/whoami
  const config = readConfig();
  const name = activeProfile(config, profileName);
  const stored = profileOf(config, name);
  const origin = (process.env.PMCP_URL ?? stored.url ?? "").replace(/\/+$/, "");
  const token = process.env.PMCP_TOKEN ?? stored.token ?? "";
  if (origin === "") throw new Error("no hub url: run `pmcp login --url https://…` or set PMCP_URL");
  if (token === "") throw new Error(`not logged in (profile ${name}): run \`pmcp login\``);
  if (token.startsWith("pmcp_svc_")) {
    throw new Error("a pmcp_svc_ service token is refused by every consumer surface: use a session or a pmcp_sa_ key");
  }
  const response = await fetch(`${origin}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`whoami → ${response.status}: the token is not valid for ${origin}`);
  const me = (await response.json()) as WhoamiResponse;
  return { origin, token, principal: me.principal, namespace: me.namespace };
}

/** One JSON-RPC request against a scoped MCP endpoint — the hub is POST-only (§7). */
async function rpc(ctx: CliContext, path: string, method: string, params?: unknown): Promise<unknown> {
  const response = await fetch(`${ctx.origin}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  if (!response.ok) throw new Error(`${method} → HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { code: number; message: string; data?: unknown } };
  // §7 answers 200 whether or not it refused: a JSON-RPC error is the refusal.
  if (body.error !== undefined) throw new HubRpcError(body.error.code, body.error.message, body.error.data);
  return body.result;
}

/**
 * One tools/list against `POST <origin>/<namespace>/mcp/<slug>` through the
 * official MCP client — a short-lived stateless session per invocation (the
 * hub is POST-only, §7). Returns the grant-filtered descriptors exactly as the
 * hub sent them; a JSON-RPC error reply is thrown as HubRpcError.
 */
async function mcpList(ctx: CliContext, slug: string): Promise<unknown[]> {
  // deps: @modelcontextprotocol/client (Streamable HTTP transport) · HubRpcError
  const result = (await rpc(ctx, `/${ctx.namespace}/mcp/${slug}`, "tools/list")) as { tools?: unknown[] };
  return result?.tools ?? [];
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
  return rpc(ctx, `/${ctx.namespace}/mcp/${slug}`, "tools/call", { name: tool, arguments: args });
}

/** One admin op through the builtin `pmcp` service, unwrapped to its structuredContent (§8). */
async function adminOp(ctx: CliContext, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = (await mcpCall(ctx, PMCP_SLUG, name, args)) as { structuredContent?: Record<string, unknown> };
  return result?.structuredContent ?? {};
}

/**
 * The one reader of a list-shaped op result: `rows<ServiceRow>(await adminOp(…),
 * "services")`. The typed row is the point — every caller shares ServiceRow / AccountRow
 * instead of re-deriving a row's shape by hand at each rendering site.
 */
function rows<T>(result: Record<string, unknown>, key: string): T[] {
  return (Array.isArray(result[key]) ? result[key] : []) as T[];
}

/** The reserved slug §8 pins for the hub's own tools. */
const PMCP_SLUG = "pmcp";

/**
 * The diff planner's entire view of the server, read in exactly two calls —
 * service_list plus account_list (§8 pins that grants ride account_list
 * inline; there is no separate grant-read tool) — reshaped into
 * plan.CurrentState. Read-only.
 */
async function readCurrentState(ctx: CliContext): Promise<CurrentState> {
  // deps: mcpCall
  const services = rows<ServiceRow>(await adminOp(ctx, "service_list"), "services");
  const accounts = rows<AccountRow>(await adminOp(ctx, "account_list"), "accounts");
  return {
    services: services.map(
      (row): CurrentService => ({
        slug: row.slug,
        // The builtin row reports `kind: "builtin"`; the planner only ever needs to know
        // that it is not plannable.
        kind: row.kind === "proxy" ? "proxy" : "tunnel",
        name: row.name,
        description: row.description,
        archived: row.archived,
        builtin: row.builtin === true,
        roles: row.roles,
        redact: row.redact,
        redactResults: row.redactResults,
        logBodies: row.logBodies,
        ...(row.kind === "proxy"
          ? {
              endpoint: row.endpoint ?? "",
              auth: row.auth ?? "headers",
              forwardIdentity: row.forwardIdentity === true,
            }
          : {}),
      }),
    ),
    accounts: accounts.map(
      (row): CurrentAccount => ({
        slug: row.slug,
        name: row.name,
        description: row.description,
        // account_list carries grants inline, as the flat `role[:approval]` strings
        // grant_set takes — the planner works in the split shape.
        grants: Object.fromEntries(
          Object.entries(row.grants).map(([service, roles]) => [service, roles.map(splitGrant)]),
        ),
      }),
    ),
  };
}

/** `reader:approval` → approval mode; anything else is an allow grant of that name. */
function splitGrant(role: string): DesiredGrant {
  return role.endsWith(":approval")
    ? { role: role.slice(0, -":approval".length), mode: "approval" }
    : { role, mode: "allow" };
}

/**
 * The one human rendering of a Plan, shared by diff and apply so the two can
 * never disagree about what a plan looks like: one summary line per step with
 * destructive steps flagged, then warnings, then hard errors. Pure string
 * building; printing is the caller's.
 */
function renderPlan(p: Plan): string {
  // deps: none
  const lines = p.steps.map((step) => `  ${step.destructive ? "!" : "+"} ${step.summary}`);
  if (lines.length === 0) lines.push("  (no changes)");
  for (const warning of p.warnings) lines.push(`  warning: ${warning}`);
  for (const error of p.errors) lines.push(`  ERROR: ${error}`);
  return lines.join("\n");
}

// ── the auth family: the only commands that are not MCP-tool sugar ─────────────────────

/** The RFC 8628 client identifier this CLI presents; better-auth records it on the code. */
const DEVICE_CLIENT_ID = "pmcp-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * The auth family — the only commands that are not MCP-tool sugar (§10) and
 * the only writer of `~/.config/pmcp/config.toml`. `login` runs the RFC 8628
 * device flow against better-auth's endpoints: prints the user code and the
 * /device URL, polls until approved (~10 min device-code lifetime, §13), then
 * stores origin + session token IN THE ACTIVE PROFILE ALONE; `url` (or PMCP_URL)
 * picks the hub. `logout` revokes the session server-side and clears that one
 * profile's token. Every other key in the file — the other profiles, the
 * top-level default, a hand-written `bootstrap_secret` — is carried through
 * both writes untouched (§10, §12). `whoami` prints the pinned WhoamiResponse
 * from GET /api/whoami — it works with a service-account key too. Exit 0 on
 * success, 1 on any failure.
 */
export async function auth(
  cmd: { sub: "login"; url?: string } | { sub: "logout" } | { sub: "whoami" },
  profileName?: string,
): Promise<number> {
  // deps: fetch (better-auth device-authorization + session endpoints, GET /api/whoami) · node:fs · node:os
  if (cmd.sub === "whoami") {
    const ctx = await resolveContext(profileName);
    process.stdout.write(`${ctx.principal}\nnamespace ${ctx.namespace}\n`);
    return 0;
  }
  const config = readConfig();
  const name = activeProfile(config, profileName);
  const stored = profileOf(config, name);
  if (cmd.sub === "logout") {
    const origin = process.env.PMCP_URL ?? stored.url;
    const token = process.env.PMCP_TOKEN ?? stored.token;
    if (origin !== undefined && token !== undefined && token !== "") {
      // Best effort: a session the hub already dropped is still gone locally.
      await fetch(`${origin}/api/auth/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    // The token, and nothing else: the url stays, the secret beside it stays, and the
    // other profiles are still logged in.
    (config.profiles[name] ??= {}).token = "";
    writeConfig(config);
    process.stdout.write("logged out\n");
    return 0;
  }

  const origin = (cmd.url ?? process.env.PMCP_URL ?? stored.url ?? "").replace(/\/+$/, "");
  if (origin === "") throw new Error("no hub url: pmcp login --url https://…");
  const requested = await postJson(`${origin}/api/auth/device/code`, { client_id: DEVICE_CLIENT_ID });
  const userCode = String(requested.user_code ?? "");
  const deviceCode = String(requested.device_code ?? "");
  const verification = String(requested.verification_uri_complete ?? requested.verification_uri ?? `${origin}/device`);
  if (userCode === "" || deviceCode === "") throw new Error("the hub issued no device code");
  process.stdout.write(`open ${absolute(origin, verification)} and enter the code:\n\n    ${userCode}\n\n`);

  // Poll at the interval the hub asked for, honouring slow_down, until the code dies.
  let intervalMs = Number(requested.interval ?? 5) * 1000;
  const deadline = Date.now() + Number(requested.expires_in ?? 600) * 1000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the device code expired before it was approved");
    await sleep(intervalMs);
    const response = await fetch(`${origin}/api/auth/device/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: DEVICE_GRANT_TYPE, device_code: deviceCode, client_id: DEVICE_CLIENT_ID }),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok && typeof body.access_token === "string") {
      const profile = (config.profiles[name] ??= {});
      profile.url = origin;
      profile.token = body.access_token;
      // The top-level default is set only when this write CREATES the file (§10): a
      // machine with one profile should not have to name it twice, and a machine with
      // several must never have its default moved by a login it did not ask that of.
      if (config.profile === undefined && !existsSync(configPath())) config.profile = name;
      writeConfig(config);
      const ctx = await resolveContext(name);
      process.stdout.write(`logged in as ${ctx.principal} on ${origin}\n`);
      return 0;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new Error(`device authorization failed: ${String(body.error ?? response.status)}`);
  }
}

async function postJson(url: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) throw new Error(`${url} → ${response.status} ${String(parsed.error_description ?? parsed.error ?? "")}`);
  return parsed;
}

function absolute(origin: string, uri: string): string {
  return uri.startsWith("http") ? uri : `${origin}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── the sugar: every other command is one or two admin ops ─────────────────────────────

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
  for (const row of rows<ServiceRow>(await adminOp(ctx, "service_list"), "services")) {
    const status = row.builtin === true ? "builtin" : row.kind === "proxy" ? row.connection ?? "proxy" : row.status ?? "";
    const declared = Object.keys(row.roles);
    process.stdout.write(
      `${row.slug.padEnd(20)} ${row.kind.padEnd(8)} ${status.padEnd(16)} ${
        declared.length === 0 ? "-" : declared.join(",")
      }${row.archived ? "  (archived)" : ""}\n`,
    );
  }
  return 0;
}

/**
 * `pmcp tools <service>` — the service's tools/list exactly as the current
 * token sees it (hub-filtered by grants, unprefixed names): what an agent
 * holding this token could call. Hub errors pass through as sent — -32002
 * archived, -32000 unreachable — never rephrased into something softer.
 */
export async function tools(ctx: CliContext, service: string): Promise<number> {
  // deps: mcpList
  for (const tool of (await mcpList(ctx, service)) as Record<string, any>[]) {
    process.stdout.write(`${String(tool.name).padEnd(28)} ${String(tool.description ?? "")}\n`);
  }
  return 0;
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
  try {
    const result = await mcpCall(ctx, target.service, target.tool, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof HubRpcError && error.code === HUB_ERRORS.approvalRequired) {
      const data = error.data as ApprovalRequiredData;
      process.stdout.write(
        `approval required (${data.approvalId})\n  approve at ${data.approvalUrl}\n  then re-run this exact call before ${data.expiresAt} — the arguments must be identical\n`,
      );
      return 1;
    }
    throw error;
  }
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
  if (cmd.sub === "create") {
    const created = await adminOp(ctx, "service_create", {
      slug: cmd.slug,
      kind: cmd.kind,
      ...(cmd.kind === "proxy" ? { endpoint: cmd.endpoint, auth: cmd.auth } : {}),
    });
    process.stdout.write(`created ${String((created.service as Record<string, unknown>)?.slug ?? cmd.slug)}\n`);
    if (cmd.kind !== "tunnel") return 0;
    // A tunneled service is unusable without its credential (§6): mint it here, print once.
    const minted = await adminOp(ctx, "token_issue", { kind: "service", slug: cmd.slug });
    process.stdout.write(`service token (shown once): ${String(minted.token)}\n`);
    return 0;
  }
  if (cmd.sub === "set-auth") {
    await adminOp(ctx, "service_set_upstream_auth", { slug: cmd.slug, headers: cmd.headers });
    process.stdout.write(`upstream headers replaced for ${cmd.slug}\n`);
    return 0;
  }
  if (cmd.sub === "delete" && opts.yes !== true) {
    const confirmed = await confirm(`delete ${cmd.slug}? its grants cascade and its tokens are deleted`);
    if (!confirmed) return 1;
  }
  const op = { archive: "service_archive", unarchive: "service_unarchive", delete: "service_delete", disconnect: "service_disconnect" }[
    cmd.sub
  ];
  await adminOp(ctx, op, { slug: cmd.slug });
  process.stdout.write(`${cmd.sub} ${cmd.slug}\n`);
  return 0;
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
  if (cmd.sub === "list") {
    for (const row of rows<AccountRow>(await adminOp(ctx, "account_list"), "accounts")) {
      const grants = Object.entries(row.grants)
        .map(([svc, roles]) => `${svc}=[${roles.join(",")}]`)
        .join(" ");
      process.stdout.write(`${row.slug.padEnd(20)} ${grants === "" ? "(no grants)" : grants}\n`);
    }
    return 0;
  }
  if (cmd.sub === "create") {
    await adminOp(ctx, "account_create", {
      slug: cmd.slug,
      ...(cmd.name === undefined ? {} : { name: cmd.name }),
      ...(cmd.description === undefined ? {} : { description: cmd.description }),
    });
    process.stdout.write(`created ${cmd.slug}\n`);
    return 0;
  }
  if (opts.yes !== true) {
    const confirmed = await confirm(`delete account ${cmd.slug}? its grants cascade and its tokens are deleted`);
    if (!confirmed) return 1;
  }
  await adminOp(ctx, "account_delete", { slug: cmd.slug });
  process.stdout.write(`deleted ${cmd.slug}\n`);
  return 0;
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
  if (cmd.sub !== "list") {
    const decided = await adminOp(ctx, "approval_decide", { id: cmd.id, decision: cmd.sub });
    process.stdout.write(`${String(decided.decision ?? cmd.sub)} ${String(decided.id ?? cmd.id)}\n`);
    return 0;
  }
  const listed = await adminOp(ctx, "approval_list", cmd.filter === undefined ? {} : { status: cmd.filter });
  for (const row of (listed.approvals ?? listed.rows ?? []) as Record<string, any>[]) {
    process.stdout.write(
      `${String(row.id).padEnd(24)} ${String(row.status ?? "").padEnd(9)} ${String(row.principal ?? "")} → ${String(
        row.service ?? "",
      )}/${String(row.tool ?? "")} ${JSON.stringify(row.arguments ?? {})} expires ${String(row.expiresAt ?? "")}\n`,
    );
  }
  return 0;
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
  if (cmd.sub === "issue") {
    const minted = await adminOp(ctx, "token_issue", {
      kind: cmd.kind,
      slug: cmd.slug,
      ...(cmd.expires === undefined ? {} : { expires_in: cmd.expires }),
    });
    process.stdout.write(`${String(minted.id)}\n${String(minted.token)}\n`);
    return 0;
  }
  if (cmd.sub === "revoke") {
    await adminOp(ctx, "token_revoke", { id: cmd.id });
    process.stdout.write(`revoked ${cmd.id}\n`);
    return 0;
  }
  for (const row of ((await adminOp(ctx, "token_list")).tokens ?? []) as Record<string, any>[]) {
    process.stdout.write(
      `${String(row.id).padEnd(24)} ${String(row.prefix ?? "").padEnd(12)} expires ${String(
        row.expiresAt ?? "never",
      )} last used ${String(row.lastUsedAt ?? "never")}\n`,
    );
  }
  return 0;
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
  const query: Record<string, unknown> = {
    ...(filters.account === undefined ? {} : { principal: `sa:${filters.account}` }),
    ...(filters.service === undefined ? {} : { service: filters.service }),
    ...(filters.event === undefined ? {} : { event: filters.event }),
    ...(filters.tool === undefined ? {} : { tool: filters.tool }),
    ...(filters.session === undefined ? {} : { session: filters.session }),
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    ...(filters.limit === undefined ? {} : { limit: filters.limit }),
  };
  if (opts.exportJsonl !== true) {
    const page = await adminOp(ctx, "audit_query", query);
    for (const row of (page.rows ?? []) as Record<string, unknown>[]) {
      process.stdout.write(
        `${String(row.at ?? "")} ${String(row.principal ?? "").padEnd(22)} ${String(row.event ?? "").padEnd(18)} ${String(
          row.service ?? "",
        )}/${String(row.tool ?? "")} ${String(row.outcome ?? "")}${renderBodies(row)}\n`,
      );
    }
    process.stdout.write(`${Number(page.total ?? 0)} events match\n`);
    return 0;
  }
  // The export re-queries in chunks and writes each as it arrives: the same rows as the
  // web export, never the whole result set in memory.
  const size = filters.limit ?? 100;
  for (let offset = 0; ; offset += size) {
    const page = await adminOp(ctx, "audit_query", { ...query, limit: size, offset });
    const rows = (page.rows ?? []) as unknown[];
    for (const row of rows) process.stdout.write(`${JSON.stringify(row)}\n`);
    if (rows.length < size) return 0;
  }
}

/** A recorded body's detail line — stubs as typed size placeholders, never raw bytes (§15). */
function renderBodies(row: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["args", "result"]) {
    const body = row[key];
    if (body === undefined || body === null) continue;
    parts.push(`${key}=${describeBody(body)}`);
  }
  return parts.length === 0 ? "" : `  ${parts.join(" ")}`;
}

function describeBody(body: unknown): string {
  const stub = (body as { stub?: string; contentType?: string; bytes?: number }).stub;
  if (stub === "blob") {
    const info = body as { contentType?: string; bytes?: number };
    return `‹blob ${String(info.contentType)} · ${formatBytes(info.bytes ?? 0)}›`;
  }
  if (stub === "oversize") return `‹oversize · ${formatBytes((body as { bytes?: number }).bytes ?? 0)}›`;
  return JSON.stringify(body);
}

function formatBytes(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
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
  const plan = planChanges(parseDesired(parseYaml(readFileSync(opts.file, "utf8"))), await readCurrentState(ctx));
  process.stdout.write(`${renderPlan(plan)}\n`);
  return plan.errors.length === 0 ? 0 : 1;
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
  const plan = planChanges(parseDesired(parseYaml(readFileSync(opts.file, "utf8"))), await readCurrentState(ctx));
  process.stdout.write(`${renderPlan(plan)}\n`);
  if (plan.errors.length > 0) return 1;
  if (plan.steps.length === 0) return 0;
  if (opts.yes !== true && !(await confirm(`apply ${plan.steps.length} step(s)?`))) return 1;
  let done = 0;
  for (const step of plan.steps) {
    try {
      await adminOp(ctx, step.tool, step.args);
      done += 1;
      process.stdout.write(`  ok ${step.summary}\n`);
    } catch (error) {
      // No transaction to roll back: report the completed prefix and stop.
      process.stdout.write(
        `  FAILED ${step.summary}: ${error instanceof Error ? error.message : String(error)}\n${done}/${plan.steps.length} steps applied\n`,
      );
      return 1;
    }
  }
  process.stdout.write(`${done}/${plan.steps.length} steps applied\n`);
  return 0;
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
  const row = ((await adminOp(ctx, "service_get", { slug: service })).service ?? {}) as Record<string, unknown>;
  if (row.kind !== "proxy" || row.auth !== "oauth") {
    throw new Error(`${service} is not an \`auth: oauth\` proxied service — nothing to connect`);
  }
  process.stdout.write(`${ctx.origin}/services?connect=${encodeURIComponent(service)}\n`);
  return 0;
}

// ── the command table (§8 parity, direction D) ─────────────────────────────────────────

// The table itself lives in ./commands.ts — a module with no imports, so the parity suite
// reads the same data this dispatcher uses without loading the CLI's filesystem access
// into workerd. Re-exported so a CLI consumer still finds it where the surface lives.
export { COMMANDS } from "./commands.ts";
export type { CliCommand } from "./commands.ts";

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
  const [command, ...rest] = argv;
  const flags = readFlags(rest);
  const words = flags.words;
  try {
    // `--profile <name>` is a value flag on every command, long form only (§10): it picks
    // the identity BEFORE anything is resolved, which is why it is read here and not by a
    // command's own normalizer.
    const profile = flags.value("profile");
    if (command === "login") return await auth({ sub: "login", url: flags.value("url") }, profile);
    if (command === "logout") return await auth({ sub: "logout" }, profile);
    if (command === "whoami") return await auth({ sub: "whoami" }, profile);
    if (command === undefined || command === "help" || command === "--help") {
      process.stdout.write(`${COMMAND_TABLE.map((entry) => `pmcp ${entry.name}`).join("\n")}\n`);
      return command === undefined ? 1 : 0;
    }

    const ctx = await resolveContext(profile);
    switch (command) {
      case "ls":
        return await ls(ctx);
      case "tools":
        return await tools(ctx, required(words[0], "service"));
      case "call": {
        // Partitioned by SHAPE, never by count: a word carrying `=` is an argument
        // wherever it sits, so `pmcp call news_echo text=hi` is the aggregated name plus
        // an argument and not a service called `news_echo` with a tool called `text=hi`.
        const positionals = words.filter((word) => !word.includes("="));
        if (positionals.length > 2) throw new Error(`\`${positionals[2]}\` is neither a service, a tool, nor key=value`);
        const target = required(positionals[0], "service");
        // `<slug>_<tool>` splits at the first underscore — slugs contain none (§7).
        const split = positionals.length > 1 ? { service: target, tool: positionals[1] } : splitAggregated(target);
        return await call(ctx, split, toolArguments(words.filter((word) => word.includes("=")), flags));
      }
      case "service":
        return await service(ctx, serviceCommand(words, flags), { yes: flags.has("yes") });
      case "account":
        return await account(ctx, accountCommand(words, flags), { yes: flags.has("yes") });
      case "approvals":
        return await approval(ctx, {
          sub: "list",
          filter: flags.has("pending") ? "pending" : flags.has("history") ? "history" : undefined,
        });
      case "approve":
      case "reject":
        return await approval(ctx, { sub: command, id: required(words[0], "approval id") });
      case "token":
        return await token(ctx, tokenCommand(words, flags));
      case "audit":
        return await audit(
          ctx,
          {
            account: flags.value("account"),
            service: flags.value("service"),
            event: flags.value("event"),
            tool: flags.value("tool"),
            session: flags.value("session"),
            since: flags.value("since"),
            until: flags.value("until"),
            limit: flags.value("limit") === undefined ? undefined : Number(flags.value("limit")),
          },
          { exportJsonl: flags.value("export") === "jsonl" },
        );
      case "diff":
        return await diff(ctx, { file: flags.value("file") ?? "mcps.yaml" });
      case "apply":
        return await apply(ctx, {
          file: flags.value("file") ?? "mcps.yaml",
          yes: flags.has("yes"),
        });
      case "connect":
        return await connect(ctx, required(words[0], "service"));
      default:
        process.stderr.write(`unknown command: ${command}\n`);
        return 1;
    }
  } catch (error) {
    // The hub's own message is safe to show (§15's hygiene); nothing else leaks a stack.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/**
 * The flags that take NO value, so `pmcp service --yes delete news` cannot swallow
 * `delete` as the value of `--yes` and then fail with an unrelated usage error.
 */
const BOOLEAN_FLAGS = new Set(["yes", "pending", "history", "help"]);

/** Short spellings, resolved to the long name the rest of the module reads. */
const SHORT_FLAGS: Record<string, string> = { f: "file" };

/** argv past the command word, split into positional words and flags. */
function readFlags(rest: string[]): {
  words: string[];
  has(name: string): boolean;
  value(name: string): string | undefined;
  repeated(name: string): string[];
} {
  const words: string[] = [];
  const values: [string, string][] = [];
  const present = new Set<string>();
  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index];
    // A single dash is a flag only for a spelling SHORT_FLAGS knows, so a value that
    // happens to lead with one (`--since -7d`) stays a value.
    const short = entry.startsWith("-") && !entry.startsWith("--") && SHORT_FLAGS[entry.slice(1).split("=")[0]] !== undefined;
    const dashes = entry.startsWith("--") ? 2 : short ? 1 : 0;
    if (dashes === 0) {
      words.push(entry);
      continue;
    }
    const spelling = entry.slice(dashes);
    const inline = spelling.indexOf("=");
    if (inline !== -1) {
      const name = longName(spelling.slice(0, inline));
      values.push([name, spelling.slice(inline + 1)]);
      present.add(name);
      continue;
    }
    const name = longName(spelling);
    present.add(name);
    const following = rest[index + 1];
    if (!BOOLEAN_FLAGS.has(name) && following !== undefined && !following.startsWith("--")) {
      values.push([name, following]);
      index += 1;
    }
  }
  return {
    words,
    has: (name) => present.has(name),
    value: (name) => values.find(([key]) => key === name)?.[1],
    repeated: (name) => values.filter(([key]) => key === name).map(([, value]) => value),
  };
}

function longName(spelling: string): string {
  return SHORT_FLAGS[spelling] ?? spelling;
}

function required(value: string | undefined, what: string): string {
  if (value === undefined || value === "") throw new Error(`missing ${what}`);
  return value;
}

/** `<slug>_<tool>` → its two halves; the first underscore is the split (§7). */
function splitAggregated(target: string): { service: string; tool: string } {
  const underscore = target.indexOf("_");
  if (underscore === -1) throw new Error(`\`${target}\` is not <service> <tool> or <slug>_<tool>`);
  return { service: target.slice(0, underscore), tool: target.slice(underscore + 1) };
}

/** `--json '{…}'`, or repeated `key=value` words, into one arguments object. */
function toolArguments(words: string[], flags: ReturnType<typeof readFlags>): Record<string, unknown> {
  const json = flags.value("json");
  if (json !== undefined) return JSON.parse(json) as Record<string, unknown>;
  const args: Record<string, unknown> = {};
  for (const word of words) {
    const equals = word.indexOf("=");
    // The caller partitions by shape, so this is a guard rather than a filter: a word the
    // user typed and this function dropped would be a silently empty argument object.
    if (equals === -1) throw new Error(`expected key=value, got ${word}`);
    args[word.slice(0, equals)] = word.slice(equals + 1);
  }
  return args;
}

function serviceCommand(words: string[], flags: ReturnType<typeof readFlags>): ServiceCommand {
  const [sub, slug] = words;
  if (sub === "create") {
    const endpoint = flags.value("proxied");
    if (endpoint === undefined) return { sub: "create", slug: required(slug, "slug"), kind: "tunnel" };
    return {
      sub: "create",
      slug: required(slug, "slug"),
      kind: "proxy",
      endpoint,
      auth: flags.value("auth") === "oauth" ? "oauth" : "headers",
    };
  }
  if (sub === "set-auth") {
    const headers: Record<string, string> = {};
    for (const header of flags.repeated("header")) {
      const colon = header.indexOf(":");
      if (colon === -1) throw new Error(`--header wants 'Name: value', got ${header}`);
      headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
    }
    return { sub: "set-auth", slug: required(slug, "slug"), headers };
  }
  if (sub === "archive" || sub === "unarchive" || sub === "delete" || sub === "disconnect") {
    return { sub, slug: required(slug, "slug") };
  }
  throw new Error("usage: pmcp service <create|archive|unarchive|delete|disconnect|set-auth> <slug>");
}

function accountCommand(words: string[], flags: ReturnType<typeof readFlags>): AccountCommand {
  const [sub, slug] = words;
  if (sub === "list" || sub === undefined) return { sub: "list" };
  if (sub === "create") {
    return { sub: "create", slug: required(slug, "slug"), name: flags.value("name"), description: flags.value("description") };
  }
  if (sub === "delete") return { sub: "delete", slug: required(slug, "slug") };
  throw new Error("usage: pmcp account <list|create|delete> [slug]");
}

function tokenCommand(words: string[], flags: ReturnType<typeof readFlags>): TokenCommand {
  const [sub, id] = words;
  if (sub === "list") return { sub: "list" };
  if (sub === "revoke") return { sub: "revoke", id: required(id, "token id") };
  if (sub === "issue") {
    const account = flags.value("account");
    const service = flags.value("service");
    if (account !== undefined) return { sub: "issue", kind: "service_account", slug: account, expires: flags.value("expires") };
    if (service !== undefined) return { sub: "issue", kind: "service", slug: service, expires: flags.value("expires") };
    throw new Error("pmcp token issue needs --account <slug> or --service <slug>");
  }
  throw new Error("usage: pmcp token <issue|list|revoke>");
}

/**
 * One y/n prompt on stdin; anything but y/yes is a refusal — and so is having nobody to
 * ask. A non-interactive stdin (CI, cron, `pmcp apply < /dev/null`) refuses immediately
 * instead of waiting for a `data` event that can never come: a destructive command that
 * silently applied nothing and exited 0 is the worst failure `apply` has.
 */
function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    process.stdout.write(`${question} — refused: stdin is not a terminal; pass --yes to confirm\n`);
    return Promise.resolve(false);
  }
  process.stdout.write(`${question} [y/N] `);
  return new Promise<boolean>((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.resume();
    process.stdin.once("data", (chunk: string) => {
      process.stdin.pause();
      resolve(/^y(es)?$/i.test(String(chunk).trim()));
    });
    // Closed mid-prompt is the same answer as "no", and a defined one.
    process.stdin.once("end", () => resolve(false));
  });
}
