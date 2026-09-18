/**
 * cli/src/main.ts — the pmcp command surface (§10): argv in, exit code out.
 *
 * This module owns the CLI's presentation layer: argv parsing, global switches,
 * rendering, exit codes, and the copied wire shapes below. It hides transport behind
 * the MCP request helpers: every command except authentication and profiles is
 * presentation sugar over the same MCP methods available to an authenticated caller.
 *
 * config.ts owns the profile store and precedence, render.ts owns table/schema/JSON
 * rendering, and errors.ts owns the stable error grammar. This file composes them.
 *
 * ponytail: the "official MCP client" is not installed, so the two seams below speak the
 * hub's stateless POST endpoint with `fetch` — one JSON-RPC message per request, exactly
 * what §7 serves. Swap them for the SDK client the day it is a dependency; nothing above
 * them knows the difference.
 */

import { existsSync } from "node:fs";
import { Command, CommanderError } from "commander";
// The extension is spelled out so `node --experimental-strip-types cli/src/main.ts` can
// resolve it — Node's own type stripping resolves a relative import only WITH one.
import {
  activeProfile,
  configPath,
  profileOf,
  readConfig,
  resolveActiveProfile,
  writeConfig,
} from "./config.ts";
import { CliError, didYouMean, emitError } from "./errors.ts";
import { catalogLine, columnize, renderJson, schemaTable, styling, wrapText } from "./render.ts";

/** Printed by `--version`. Duplicated from cli/package.json because the dist build is a
 *  source-to-dist transform with no JSON reader — held in step by the parity test in
 *  cli/test/commands.test.ts rather than by hand, since "by hand" is how it last drifted. */
const VERSION = "0.2.0";

/**
 * COPIED wire shape — the GET /api/whoami response, pinned by §8 as the
 * CLI↔server contract. Deliberately duplicated here rather than shared through
 * a package; tests pin both sides. `principal` is `"user:<name>"` or
 * `"agent:<slug>"`; `namespace` is the owner username every `/<user>/mcp…` URL is
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
 * A role declaration in the canonical `app_list` / `app_get` wire shape: tools-only
 * roles use a bare pattern list; multi-family roles use a family-to-patterns object.
 */
type RoleDeclaration = Record<string, string[] | Record<string, string[]>>;

/**
 * COPIED wire shape — one `app_list` / `app_get` row (§8's pinned cross-front
 * shape, the server's own `AppRow`). Deliberately duplicated (no shared package) and
 * flat where the server's is a discriminated union: the CLI branches on `kind` at
 * runtime, so per-kind fields are optional here.
 */
export type AppRow = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  logBodies: boolean;
  roles: RoleDeclaration;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
  kind: "tunnel" | "proxy" | "builtin";
  /** builtin rows only — the virtual `pmcp` app */
  builtin?: boolean;
  /** tunneled rows only */
  status?: "online" | "offline";
  /** tunneled rows only — §20.3's owner-defined roles, beside the app's own `roles` */
  ownerRoles?: RoleDeclaration;
  /** proxied rows only */
  endpoint?: string;
  auth?: "headers" | "oauth";
  forwardIdentity?: boolean;
  /** proxied rows only, and absent when the app never declared one (§8, §20.2) */
  capabilities?: string[];
  /** proxied `auth: oauth` rows only — the upstream connection state */
  connection?: string;
};

/**
 * COPIED wire shape — one `agent_list` row, with grants inline as the flat
 * `role[:approval]` strings accepted by `grant_set`.
 */
export type AgentRow = {
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
  appUnavailable: -32000,
  toolNotPermitted: -32001,
  appArchived: -32002,
  approvalRequired: -32003,
  invalidParams: -32602,
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
 * bearer token (session or `pmcp_agt_` — never `pmcp_app_`, §10), and the
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

// ── the invocation-wide switches (§10's output contract) ────────────────────────────────

/**
 * The flags that apply to every command, extracted from argv BEFORE commander sees it.
 * They are global in position as well as in meaning — `pmcp app --yes delete news` and
 * `pmcp app delete news --yes` are the same command — which commander's per-command
 * option model cannot express without redeclaring four options on thirty subcommands.
 *
 * `color` is the `--no-color` flag alone; the TTY and NO_COLOR halves of §10's gate are
 * folded in by `resetOutput` below, so every renderer downstream reads one boolean.
 */
type Globals = { profile?: string; json: boolean; color: boolean; yes: boolean; words: string[] };

let globals: Globals = { json: false, color: true, yes: false, words: [] };

/** Set by a command that printed its result and still must not exit 0 (an `isError` tool result). */
let pendingExit: 0 | 1 = 0;

/**
 * What commander wrote to its error stream. Buffered rather than printed, because commander
 * puts two different things there: its own `error: …` prose, which emitError re-renders with
 * a code, and the HELP of a family invoked with no subcommand, which §10 wants on stdout.
 */
let commanderOut = "";

function extractGlobals(argv: string[]): Globals {
  const words: string[] = [];
  const found: Globals = { json: false, color: true, yes: false, words };
  for (let index = 0; index < argv.length; index += 1) {
    const word = argv[index];
    if (word === "--json") found.json = true;
    else if (word === "--no-color") found.color = false;
    else if (word === "--yes") found.yes = true;
    else if (word === "--profile") found.profile = argv[(index += 1)];
    else if (word.startsWith("--profile=")) found.profile = word.slice("--profile=".length);
    else words.push(word);
  }
  return found;
}

/** True when human output may carry color and `…` truncation: a TTY, unhindered (§10). */
function decorated(): boolean {
  return globals.color && (process.env.NO_COLOR ?? "") === "" && process.stdout.isTTY === true;
}

function write(text: string): void {
  process.stdout.write(text);
}

/**
 * The color gate for JSON stdout. `--json` is a MACHINE stream (§10: one JSON document on
 * stdout, nothing else), and an agent harness commonly allocates a pty — so the TTY half of
 * `decorated()` must not apply here, or the exact consumer this redesign is built for gets
 * bytes `JSON.parse` rejects. Human result rendering keeps its color.
 */
function documentColor(): boolean {
  return !globals.json && decorated();
}

/** The single `--json` document a data command emits: stdout, nothing else on stdout (§10). */
function emitDocument(value: unknown): number {
  write(`${renderJson(value, documentColor())}\n`);
  return 0;
}

// ── config, context, transport ──────────────────────────────────────────────────────────

/**
 * Builds the per-invocation context: the ACTIVE profile's stored url/token overlaid
 * by the flat PMCP_URL / PMCP_TOKEN (the environment is profile-free, §10), then one
 * GET /api/whoami to learn principal and namespace (§10 — this is how an agent
 * key learns whose namespace it lives in). A `pmcp_app_`-prefixed token is refused here
 * with a clear message — every consumer surface rejects app tokens, so failing early
 * beats a confusing server 401; no token at all fails with a "run pmcp login" hint that
 * names the profile, since a `--profile` typo and an expired session look identical
 * otherwise.
 */
async function resolveContext(profileName?: string): Promise<CliContext> {
  // deps: config.readConfig · node:process · fetch GET /api/whoami
  const config = readConfig();
  const name = activeProfile(config, profileName);
  const stored = profileOf(config, name);
  const origin = (process.env.PMCP_URL ?? stored.url ?? "").replace(/\/+$/, "");
  const token = process.env.PMCP_TOKEN ?? stored.token ?? "";
  if (origin === "") {
    throw new CliError("no_url", `no hub url for profile ${name}`, {
      hints: ["pmcp login --url https://…", "or set PMCP_URL"],
    });
  }
  if (token === "") {
    throw new CliError("unauthenticated", `not logged in (profile ${name})`, { hints: [`pmcp login --profile ${name}`] });
  }
  if (token.startsWith("pmcp_app_")) {
    throw new CliError(
      "unauthenticated",
      "a pmcp_app_ app token is refused by every consumer surface: use a session or a pmcp_agt_ key",
    );
  }
  const response = await fetch(`${origin}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new CliError("unauthenticated", `whoami → ${response.status}: the token is not valid for ${origin}`);
  }
  const me = (await response.json()) as WhoamiResponse;
  return { origin, token, principal: me.principal, namespace: me.namespace };
}

/** The context every sugar command opens with — one place, so `--profile` is read once. */
function context(): Promise<CliContext> {
  return resolveContext(globals.profile);
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

/** The scoped endpoint an app's own gateway methods are addressed to (§20.2). */
function scoped(ctx: CliContext, slug: string): string {
  return `/${ctx.namespace}/mcp/${slug}`;
}

/**
 * One tools/list against `POST <origin>/<namespace>/mcp/<slug>` — a short-lived stateless
 * session per invocation (the hub is POST-only, §7). Returns the grant-filtered descriptors
 * exactly as the hub sent them; a JSON-RPC error reply is thrown as HubRpcError.
 */
async function mcpList(ctx: CliContext, slug: string): Promise<unknown[]> {
  const result = (await rpc(ctx, scoped(ctx, slug), "tools/list")) as { tools?: unknown[] };
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
  return rpc(ctx, scoped(ctx, slug), "tools/call", { name: tool, arguments: args });
}

/** One admin op through the builtin `pmcp` app, unwrapped to its structuredContent (§8). */
async function adminOp(ctx: CliContext, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = (await mcpCall(ctx, PMCP_SLUG, name, args)) as { structuredContent?: Record<string, unknown> };
  return result?.structuredContent ?? {};
}

/**
 * §22.1's CLI-side half of the acceptance table: a `pmcp_adm_` admin token administers
 * the hub and reaches no single app's own tools, so commands that address one refuse it
 * before any request. The refusal is target-based: the builtin `pmcp` app is the admin
 * surface itself, and the virtual `hub` app's scoped endpoint is explicitly admitted —
 * §23.1 has the hub's program snapshot carry only the `adminOpsFor` subset there, so the
 * admission grants nothing an admin token could not already reach.
 */
function refuseAdminToken(ctx: CliContext, app: string): void {
  if (!ctx.token.startsWith("pmcp_adm_")) return;
  if (app === PMCP_SLUG || app === HUB_SLUG) return;
  throw new CliError(
    "unauthenticated",
    "a pmcp_adm_ admin token administers the hub and cannot reach a single app's tools",
  );
}

/**
 * The one reader of a list-shaped op result: `rows<AppRow>(await adminOp(…),
 * "apps")`. The typed row is the point — every caller shares AppRow / AgentRow
 * instead of re-deriving a row's shape by hand at each rendering site.
 */
function rows<T>(result: Record<string, unknown>, key: string): T[] {
  return (Array.isArray(result[key]) ? result[key] : []) as T[];
}

/** The reserved slug §8 pins for the hub's own tools. */
const PMCP_SLUG = "pmcp";

/** The reserved virtual slug §23.1 pins beside `pmcp`: the hub's own execution service,
 *  with no app row, never archived, and addressable by every credential kind the CLI holds
 *  — including admin tokens, which the real-app refusal above must not catch. */
const HUB_SLUG = "hub";


// ── the auth family: the only commands that are not MCP-tool sugar ─────────────────────

/** The RFC 8628 client identifier this CLI presents; better-auth records it on the code. */
const DEVICE_CLIENT_ID = "pmcp-cli";
const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/**
 * `pmcp whoami` — the pinned WhoamiResponse from GET /api/whoami, principal AND namespace
 * in both renderings (§10: for an agent key the two differ, and the namespace is
 * what every `/<user>/mcp…` URL is built from). Logged out is `unauthenticated`, exit 1 —
 * resolveContext raises it before any request.
 */
export async function whoami(): Promise<number> {
  const ctx = await context();
  const profile = resolveActiveProfile(globals.profile).name;
  if (globals.json) {
    return emitDocument({ principal: ctx.principal, namespace: ctx.namespace, url: ctx.origin, profile });
  }
  const c = styling(decorated());
  write(`${c.bold(ctx.principal)} @ ${ctx.origin} (namespace ${ctx.namespace}, profile ${profile})\n`);
  return 0;
}

/** `pmcp logout` — revokes the session server-side, then clears the ACTIVE profile's token alone. */
export async function logout(): Promise<number> {
  const config = readConfig();
  const name = activeProfile(config, globals.profile);
  const stored = profileOf(config, name);
  const origin = process.env.PMCP_URL ?? stored.url;
  const token = process.env.PMCP_TOKEN ?? stored.token;
  if (origin !== undefined && token !== undefined && token !== "") {
    // Best effort: a session the hub already dropped is still gone locally.
    await fetch(`${origin}/api/auth/sign-out`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }).catch(
      () => undefined,
    );
  }
  // The token, and nothing else: the url stays, the secret beside it stays, and the
  // other profiles are still logged in.
  (config.profiles[name] ??= {}).token = "";
  writeConfig(config);
  if (globals.json) return emitDocument({ profile: name, token: false });
  write("logged out\n");
  return 0;
}

/**
 * `pmcp login [--profile <name>] [--url <origin>]` — the RFC 8628 device flow against
 * better-auth's endpoints, and the only writer of a profile's token. On a TTY a missing
 * url is asked for (@clack); with `--json` the device document goes to stdout the moment
 * the hub issues it and the outcome document follows, with every line of chatter on stderr
 * (§10's output contract: one machine-readable stream). Polling stops at the device code's
 * own expiry — `login_timeout`, never an unbounded wait. The write touches ONE profile;
 * the top-level default is set only when this write creates the file.
 */
export async function login(url?: string): Promise<number> {
  const config = readConfig();
  const name = activeProfile(config, globals.profile);
  const stored = profileOf(config, name);
  let origin = (url ?? process.env.PMCP_URL ?? stored.url ?? "").replace(/\/+$/, "");
  if (origin === "" && process.stdin.isTTY === true && !globals.json) origin = (await askForUrl()).replace(/\/+$/, "");
  if (origin === "") {
    throw new CliError("no_url", "no hub url", { hints: ["pmcp login --url https://…"] });
  }

  const requested = await postJson(`${origin}/api/auth/device/code`, { client_id: DEVICE_CLIENT_ID });
  const userCode = String(requested.user_code ?? "");
  const deviceCode = String(requested.device_code ?? "");
  const verification = absolute(origin, String(requested.verification_uri_complete ?? requested.verification_uri ?? `${origin}/device`));
  const expiresIn = Number(requested.expires_in ?? 600);
  if (userCode === "" || deviceCode === "") throw new CliError("remote_error", "the hub issued no device code");
  if (globals.json) {
    write(`${JSON.stringify({ verificationUri: verification, userCode, expiresIn })}\n`);
    process.stderr.write(`waiting for approval at ${verification}\n`);
  } else {
    write(`Visit ${verification} and enter code ${userCode}\n`);
  }

  // Poll at the interval the hub asked for, honouring slow_down, until the code dies.
  let intervalMs = Number(requested.interval ?? 5) * 1000;
  const deadline = Date.now() + expiresIn * 1000;
  for (;;) {
    if (Date.now() > deadline) {
      throw new CliError("login_timeout", "the device code expired before it was approved", {
        hints: ["pmcp login"],
      });
    }
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
      if (globals.json) {
        // Compact, like the device document above it: `login --json` is the one command
        // that writes TWO documents to one stream (mock §3), and a pretty-printed pair
        // could not be read back a line at a time.
        write(`${JSON.stringify({ principal: ctx.principal, namespace: ctx.namespace, profile: name })}\n`);
        return 0;
      }
      write(`Logged in as ${ctx.principal} (profile ${name})\n`);
      return 0;
    }
    if (body.error === "authorization_pending") continue;
    if (body.error === "slow_down") {
      intervalMs += 5_000;
      continue;
    }
    throw new CliError("remote_error", `device authorization failed: ${String(body.error ?? response.status)}`);
  }
}

/**
 * The one interactive prompt outside `profile add` (§10): only on a TTY, only for a piece
 * the invocation genuinely lacks. @clack is imported dynamically so the module graph of a
 * non-interactive run — including the parity suite, which imports this file inside workerd
 * — never loads a terminal library it will not use.
 */
async function askForUrl(): Promise<string> {
  const { isCancel, text } = await import("@clack/prompts");
  const answer = await text({ message: "Hub URL", placeholder: "https://hub.example.com" });
  if (isCancel(answer) || typeof answer !== "string" || answer.trim() === "") {
    throw new CliError("no_url", "no hub url", { hints: ["pmcp login --url https://…"] });
  }
  return answer.trim();
}

async function postJson(url: string, body: unknown): Promise<Record<string, any>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const parsed = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    throw new CliError("remote_error", `${url} → ${response.status} ${String(parsed.error_description ?? parsed.error ?? "")}`);
  }
  return parsed;
}

function absolute(origin: string, uri: string): string {
  return uri.startsWith("http") ? uri : `${origin}${uri.startsWith("/") ? "" : "/"}${uri}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── the profile family: config-file only, never a network call ─────────────────────────

/** One `pmcp profile …` invocation, normalized from argv. */
export type ProfileCommand =
  | { sub: "add"; name: string; url: string }
  | { sub: "list" }
  | { sub: "use"; name: string }
  | { sub: "remove"; name: string };

/**
 * `pmcp profile add|list|use|remove` — the profile store as a command surface (§10). Never
 * touches the network: `add` writes a url alone (login fills the token) and NEVER destroys
 * a credential — a url change on a profile that already holds a token warns instead of
 * clearing it; `use` moves the top-level default; `remove` drops one table, and refuses to
 * drop the ACTIVE one without `--yes`.
 */
export async function profile(cmd: ProfileCommand): Promise<number> {
  const config = readConfig();
  const resolved = resolveActiveProfile(globals.profile);
  if (cmd.sub === "list") {
    const names = Object.keys(config.profiles).sort();
    if (globals.json) {
      return emitDocument({
        active: resolved.name,
        activeSource: resolved.source,
        profiles: names.map((name) => ({
          name,
          url: config.profiles[name].url ?? "",
          token: (config.profiles[name].token ?? "") !== "",
          bootstrapSecret: (config.profiles[name].bootstrap_secret ?? "") !== "",
        })),
      });
    }
    const c = styling(decorated());
    const table = columnize(
      names.map((name) => {
        const entry = config.profiles[name];
        const state =
          (entry.token ?? "") !== "" ? "logged in" : (entry.bootstrap_secret ?? "") !== "" ? "bootstrap only" : "no token";
        return [`${name === resolved.name ? "*" : " "} ${name}`, entry.url ?? "", state];
      }),
      { tty: decorated() },
    );
    write(table === "" ? "no profiles yet: pmcp login --url https://…\n" : `${c.reset(table)}\n`);
    return 0;
  }
  if (cmd.sub === "add") {
    const existing = config.profiles[cmd.name];
    const hadToken = (existing?.token ?? "") !== "";
    const changedUrl = existing !== undefined && (existing.url ?? "") !== cmd.url;
    (config.profiles[cmd.name] ??= {}).url = cmd.url;
    writeConfig(config);
    if (globals.json) {
      return emitDocument({ name: cmd.name, url: cmd.url, token: hadToken });
    }
    write(`profile ${cmd.name} → ${cmd.url}\n`);
    if (hadToken && changedUrl) write(`token was issued by the previous origin: pmcp login --profile ${cmd.name}\n`);
    else if (!hadToken) write(`no token yet: pmcp login --profile ${cmd.name}\n`);
    return 0;
  }
  if (cmd.sub === "use") {
    if (config.profiles[cmd.name] === undefined) {
      throw new CliError("not_found", `no profile "${cmd.name}"`, { hints: ["pmcp profile list"] });
    }
    config.profile = cmd.name;
    writeConfig(config);
    if (globals.json) return emitDocument({ active: cmd.name, activeSource: "config" });
    write(`default profile → ${cmd.name}\n`);
    return 0;
  }
  if (config.profiles[cmd.name] === undefined) {
    throw new CliError("not_found", `no profile "${cmd.name}"`, { hints: ["pmcp profile list"] });
  }
  if (cmd.name === resolved.name && !globals.yes) {
    if (!(await confirm(`remove the ACTIVE profile ${cmd.name}? its stored token goes with it`))) return 1;
  }
  delete config.profiles[cmd.name];
  if (config.profile === cmd.name) delete config.profile;
  writeConfig(config);
  if (globals.json) return emitDocument({ removed: cmd.name });
  write(`removed ${cmd.name}\n`);
  return 0;
}

// ── the sugar: every other command is one or two admin ops ─────────────────────────────

/**
 * `pmcp ls` — the namespace at a glance: every app with kind, status
 * (online/offline for tunneled; not-connected/connected/needs-reconnect for
 * `auth: oauth` proxied, plain "proxy" otherwise), declared roles, and
 * archived flag; the builtin `pmcp` row shows as builtin. Sugar over
 * app_list — with an agent key it fails like every admin-backed
 * command, since agents never hold `pmcp` grants (§8, §10).
 *
 * `--json` passes the `app_list` rows through untouched: wire vocabulary, wire fields,
 * nothing renamed (§10).
 */
export async function ls(ctx: CliContext): Promise<number> {
  // deps: mcpCall · render.columnize
  // No refuseAdminToken here, unlike the six consumer subcommands: `ls` fronts `app_list`, an
  // ADMIN op on /mcp/pmcp, which §22.1's acceptance table grants `pmcp_adm_` outright. The other
  // six address /mcp/<app-slug> and are refused because that surface is closed to admin tokens.
  // Refusing inventory client-side would deny a credential something the hub honours.
  const apps = rows<AppRow>(await adminOp(ctx, "app_list"), "apps");
  if (globals.json) return emitDocument({ apps });
  const c = styling(decorated());
  const table = columnize(
    apps.map((row) => [
      row.slug,
      row.kind,
      statusOf(row),
      declaredRoles(row),
      row.archived ? "(archived)" : "",
    ]),
    {
      headers: ["APP", "KIND", "STATUS", "ROLES", ""],
      tty: decorated(),
      // Painted per CELL: a slug that happens to contain the status word (`online-notes`,
      // `proxy-cache`) would make a search-and-replace over the rendered line colour the
      // wrong column and then slice through the escape it had just inserted.
      style: (cell, column) =>
        column === 0 ? c.bold(cell) : column === 2 ? statusColor(c, cell)(cell) : cell,
    },
  ).split("\n");
  write(`${c.dim(table[0])}\n`);
  for (const line of table.slice(1)) write(`${line}\n`);
  return 0;
}

/** §10's status colours: online green, offline red, builtin dim, anything else unpainted. */
function statusColor(c: ReturnType<typeof styling>, status: string): (value: string) => string {
  if (status === "online") return c.green;
  if (status === "offline") return c.red;
  if (status === "builtin") return c.dim;
  return (value) => value;
}

/** The wire's own status word for a row — never a CLI-private respelling (§10). */
function statusOf(row: AppRow): string {
  if (row.builtin === true || row.kind === "builtin") return "builtin";
  if (row.kind === "proxy") return row.connection ?? "proxy";
  return row.status ?? "";
}

function declaredRoles(row: AppRow): string {
  const declared = Object.keys(row.roles ?? {});
  return declared.length === 0 ? "-" : declared.join(", ");
}

/**
 * `pmcp tools <app>` (hidden alias; `describe app/<slug>` is the documented
 * surface) — the app's tools/list exactly as the current token sees it (hub-filtered
 * by grants, unprefixed names). Hub errors pass through as sent.
 */
export async function tools(ctx: CliContext, app: string): Promise<number> {
  // deps: mcpList
  refuseAdminToken(ctx, app);
  const listed = (await mcpList(ctx, app)) as Record<string, any>[];
  if (globals.json) return emitDocument({ app, tools: listed });
  for (const tool of listed) write(`${catalogLine(String(tool.name), String(tool.description ?? ""), 28, decorated())}\n`);
  return 0;
}

/**
 * `pmcp call` — one tools/call against the scoped endpoint, result JSON to
 * stdout. `target` is exactly the two positionals main parsed (`<app> <tool>`;
 * the aggregate endpoint serves no application tools since §23.1, so the old
 * `<slug>_<tool>` split has no destination and is gone); `args` is the parsed
 * `--args`/`key=value` object, sent verbatim. A result carrying `isError: true` is still
 * PRINTED and exits 1 (§10). A hub refusal is enriched once, on the error path only, with
 * what the caller should have sent.
 */
export async function call(
  ctx: CliContext,
  target: { app: string; tool: string },
  args: Record<string, unknown>,
): Promise<number> {
  // deps: mcpCall · enrichCallFailure
  refuseAdminToken(ctx, target.app);
  try {
    const result = (await mcpCall(ctx, target.app, target.tool, args)) as { isError?: boolean };
    write(`${renderJson(result, documentColor())}\n`);
    return result?.isError === true ? 1 : 0;
  } catch (error) {
    throw await enrichCallFailure(ctx, target, args, error);
  }
}

/**
 * §10's "one best-effort enrichment fetch on the error path only": a hub refusal is turned
 * into a CliError that says what the caller should have sent, using the catalog it did not
 * consult before the call. Every fetch here is wrapped — an enrichment that itself fails
 * silently degrades to the bare refusal, and none of it ever runs on the happy path.
 */
async function enrichCallFailure(
  ctx: CliContext,
  target: { app: string; tool: string },
  args: Record<string, unknown>,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof HubRpcError)) return error;
  if (error.code === HUB_ERRORS.approvalRequired) {
    const data = error.data as ApprovalRequiredData;
    return new CliError("approval_required", `approval required (${data.approvalId})`, {
      detail: [`approve at ${data.approvalUrl}`, `then re-run this exact call before ${data.expiresAt} — the arguments must be identical`],
      extra: { approvalId: data.approvalId, approvalUrl: data.approvalUrl, expiresAt: data.expiresAt },
    });
  }
  const catalog = await catalogOf(ctx, target.app);
  if (error.code === HUB_ERRORS.toolNotPermitted) {
    if (catalog === undefined) {
      // The app itself did not answer: the slug, not the tool, is what is wrong.
      const slugs = await appSlugs(ctx);
      const suggestion = slugs === undefined ? undefined : didYouMean(target.app, slugs);
      return new CliError("not_found", `no app "${target.app}" in your namespace`, {
        detail: suggestion === undefined ? [] : [`did you mean "${suggestion}"?`],
        hints: ["pmcp ls lists your apps"],
        extra: suggestion === undefined ? undefined : { didYouMean: suggestion },
      });
    }
    const suggestion = didYouMean(target.tool, catalog.map((tool) => String(tool.name)));
    return new CliError("not_found", `no tool "${target.tool}" on ${target.app}`, {
      detail: suggestion === undefined ? [] : [`did you mean "${suggestion}"?`],
      hints: [`pmcp describe app/${target.app} lists everything it serves`],
      extra: suggestion === undefined ? undefined : { didYouMean: suggestion },
    });
  }
  if (error.code === HUB_ERRORS.invalidParams) {
    const descriptor = catalog?.find((tool) => String(tool.name) === target.tool);
    const schema = descriptor?.inputSchema as { properties?: Record<string, unknown> } | undefined;
    const known = Object.keys(schema?.properties ?? {});
    const unknownArg = Object.keys(args).find((key) => known.length > 0 && !known.includes(key));
    const suggestion = unknownArg === undefined ? undefined : didYouMean(unknownArg, known);
    const detail: string[] = [];
    if (suggestion !== undefined) detail.push(`did you mean "${suggestion}"?`);
    if (schema !== undefined) detail.push(`${target.tool} expects\n${indent(schemaTable(schema, decorated()), 2)}`);
    return new CliError("invalid_arguments", error.message, {
      detail,
      hints: [`pmcp describe app/${target.app}/${target.tool}`],
      extra:
        schema === undefined && suggestion === undefined
          ? undefined
          : { ...(suggestion === undefined ? {} : { didYouMean: suggestion }), ...(schema === undefined ? {} : { expectedArguments: schema }) },
    });
  }
  return error;
}

/** The app's tools/list, or undefined when the fetch itself failed (best effort, §10). */
async function catalogOf(ctx: CliContext, app: string): Promise<Record<string, any>[] | undefined> {
  try {
    return (await mcpList(ctx, app)) as Record<string, any>[];
  } catch {
    return undefined;
  }
}

/** Every slug in the namespace, or undefined — an agent key cannot read this (§8). */
async function appSlugs(ctx: CliContext): Promise<string[] | undefined> {
  try {
    return rows<AppRow>(await adminOp(ctx, "app_list"), "apps").map((row) => row.slug);
  } catch {
    return undefined;
  }
}

function indent(text: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => (line === "" ? line : pad + line))
    .join("\n");
}

// ── §20.6: the data-model commands, gateway sugar of exactly the kind `tools`/`call`
//    already are — they front an MCP method on the scoped endpoint, never an admin op ─────

/**
 * `pmcp prompts <app>` (hidden alias of `describe`) — `prompts/list` on the SCOPED
 * endpoint (§20.2/§20.6): only there does a prompt keep the unprefixed name the app
 * gave it. One row per prompt, name then description.
 */
export async function prompts(ctx: CliContext, app: string): Promise<number> {
  // deps: rpc
  refuseAdminToken(ctx, app);
  const result = (await rpc(ctx, scoped(ctx, app), "prompts/list")) as { prompts?: unknown[] };
  const listed = (result?.prompts ?? []) as Record<string, any>[];
  if (globals.json) return emitDocument({ app, prompts: listed });
  for (const entry of listed) write(`${catalogLine(String(entry.name), String(entry.description ?? ""), 28, decorated())}\n`);
  return 0;
}

/**
 * `pmcp get prompt/<app>/<name> [key=value …]` (and the hidden `pmcp prompt` alias) —
 * `prompts/get` on the scoped endpoint, the `key=value` grammar `pmcp call` already speaks
 * landing exactly where the method declares it: `params.arguments`, beside the prompt's own
 * `name` and nowhere else.
 */
export async function prompt(
  ctx: CliContext,
  app: string,
  name: string,
  args: Record<string, unknown>,
): Promise<number> {
  // deps: rpc
  refuseAdminToken(ctx, app);
  const result = await rpc(ctx, scoped(ctx, app), "prompts/get", { name, arguments: args });
  write(`${renderJson(result, documentColor())}\n`);
  return 0;
}

/**
 * `pmcp resources <app> [--templates]` (hidden alias of `describe`) — `resources/list`
 * on the scoped endpoint, or `resources/templates/list` when `--templates` is given
 * (§20.2/§20.6). §20.2 keys this family by `uri`, never by `name`, so each row prints the
 * uri; a template row prints the RAW `uriTemplate`, unexpanded.
 */
export async function resources(ctx: CliContext, app: string, opts: { templates?: boolean }): Promise<number> {
  // deps: rpc
  refuseAdminToken(ctx, app);
  if (opts.templates === true) {
    const result = (await rpc(ctx, scoped(ctx, app), "resources/templates/list")) as { resourceTemplates?: unknown[] };
    const listed = (result?.resourceTemplates ?? []) as Record<string, any>[];
    if (globals.json) return emitDocument({ app, resourceTemplates: listed });
    for (const template of listed) write(`${String(template.uriTemplate)}\n`);
    return 0;
  }
  const result = (await rpc(ctx, scoped(ctx, app), "resources/list")) as { resources?: unknown[] };
  const listed = (result?.resources ?? []) as Record<string, any>[];
  if (globals.json) return emitDocument({ app, resources: listed });
  for (const resource of listed) write(`${String(resource.uri)}\n`);
  return 0;
}

/**
 * `pmcp get resource/<app>/<uri>` (and the hidden `pmcp read` alias) — `resources/read`
 * on the SLUG's scoped endpoint, the URI sent verbatim as `params.uri`: never
 * percent-encoded (it is a param value, not part of the URL) and never `<slug>_`-prefixed
 * (§20.2 refuses the aggregated endpoint precisely because a URI cannot take a prefix and
 * still be the URI the app knows). Routed by the addressed slug alone, never by the
 * URI's own scheme — two apps may legitimately serve the identical URI (§20.2).
 */
export async function read(ctx: CliContext, app: string, uri: string): Promise<number> {
  // deps: rpc
  refuseAdminToken(ctx, app);
  const result = await rpc(ctx, scoped(ctx, app), "resources/read", { uri });
  write(`${renderJson(result, documentColor())}\n`);
  return 0;
}

// ── §23: the hub's own surface — the two hub tools on the scoped /mcp/hub endpoint, and
//    the owner execution settings they are bounded by ─────────────────────────────────────

/**
 * `pmcp hub execute --args '<json>'` / `pmcp hub search-types --args '<json>'` — one
 * `tools/call` against the virtual hub app's SCOPED mount `/<namespace>/mcp/hub` (§23.1),
 * where the canonical unprefixed names are exactly `execute` and `search_types`. The
 * aggregate `hub_execute`/`hub_search_types` spelling belongs to the consumer endpoint and
 * is deliberately not what the CLI addresses: `/mcp/hub` is reachable by every credential
 * kind the CLI can hold, admin tokens included. `args` is the parsed `--args` payload, sent
 * verbatim, so `timeout_ms` reaches the sandbox as the JSON integer the operator wrote.
 * Rendering, the `isError: true` → exit 1 rule, and error-path enrichment follow
 * `pmcp call` exactly — this is the same one-tools/call-on-a-scoped-mount shape, so the
 * two commands have no reason to read differently.
 */
export async function hubCall(
  ctx: CliContext,
  tool: "execute" | "search_types",
  args: Record<string, unknown>,
): Promise<number> {
  // deps: mcpCall · enrichCallFailure
  refuseAdminToken(ctx, HUB_SLUG);
  try {
    const result = (await mcpCall(ctx, HUB_SLUG, tool, args)) as { isError?: boolean };
    write(`${renderJson(result, documentColor())}\n`);
    return result?.isError === true ? 1 : 0;
  } catch (error) {
    throw await enrichCallFailure(ctx, { app: HUB_SLUG, tool }, args, error);
  }
}

/** §23.3's compiled bounds for the owner pair, `1_000 <= default <= max <= 300_000` — the
 *  same predicate the hub enforces. The CLI checks it locally so a pair outside the bounds
 *  is argv (§10: a frame the hub is known to refuse is never sent), never a -32602. */
const HUB_TIMEOUT_MIN_MS = 1_000;
const HUB_TIMEOUT_MAX_MS = 300_000;

/** The one usage line the settings verbs and their flag parsers quote back. */
const HUB_SETTINGS_USAGE = "pmcp hub settings set --default-timeout-ms <int> --max-timeout-ms <int>";

/**
 * `pmcp hub settings get` — `hub_settings_get` through the builtin `pmcp` app (§23.3). The
 * pair is OWNER-scoped, not bearer-scoped: every credential that can reach the admin
 * surface reads the same row, and an absent row reads the pinned 30_000/30_000 default.
 */
export async function hubSettingsGet(ctx: CliContext): Promise<number> {
  // deps: adminOp
  return writeHubSettings(await adminOp(ctx, "hub_settings_get"));
}

/**
 * `pmcp hub settings set --default-timeout-ms <int> --max-timeout-ms <int>` —
 * `hub_settings_update` (§23.3): both integers, one atomic upsert, the same read shape
 * back. The dispatcher has already parsed the pair as bounded integers, so nothing here
 * coerces a string; the hub re-validates the pair authoritatively.
 */
export async function hubSettingsSet(
  ctx: CliContext,
  pair: { defaultTimeoutMs: number; maxTimeoutMs: number },
): Promise<number> {
  // deps: adminOp
  return writeHubSettings(
    await adminOp(ctx, "hub_settings_update", { default_timeout_ms: pair.defaultTimeoutMs, max_timeout_ms: pair.maxTimeoutMs }),
  );
}

/**
 * The rendering both settings verbs share: `--json` emits the op's own document
 * (`{ settings: { defaultTimeoutMs, maxTimeoutMs } }`, §23.3) untouched — wire shapes and
 * vocabulary verbatim, §10 — and a human reads the same pair as two lines. A field the hub
 * did not send prints empty rather than as the word `undefined`; the hub's shape always
 * carries both, so this is presentation slack, not a fourth state.
 */
function writeHubSettings(result: Record<string, unknown>): number {
  if (globals.json) return emitDocument(result);
  const settings = (result.settings ?? {}) as Record<string, unknown>;
  write(`default timeout  ${String(settings.defaultTimeoutMs ?? "")} ms\n`);
  write(`max timeout      ${String(settings.maxTimeoutMs ?? "")} ms\n`);
  return 0;
}

// ── describe: one path-style ref, four catalog families, two entity kinds ───────────────

/** A ref as `describe`/`get` split it: the first two slashes only, so a URI item keeps its own. */
export type Ref = { kind: string; slug: string; item?: string };

/**
 * §10's ref grammar: the FIRST segment names the kind of thing, splitting stops after the
 * second slash. `kinds` is the vocabulary the calling verb accepts — an unknown first
 * segment is a `usage` error carrying the corrected spelling, never a network call.
 */
export function parseRef(ref: string, kinds: readonly string[], verb: string): Ref {
  const first = ref.indexOf("/");
  const kind = first === -1 ? ref : ref.slice(0, first);
  if (!kinds.includes(kind)) {
    const suggestion = didYouMean(kind, kinds);
    const rest = first === -1 ? "" : ref.slice(first + 1);
    throw new CliError("usage", `unknown ref type "${kind}" (valid: ${kinds.join(", ")})`, {
      hints: suggestion === undefined ? [`pmcp ${verb} <${kinds.join("|")}>/…`] : [`pmcp ${verb} ${suggestion}/${rest}`],
      extra: suggestion === undefined ? undefined : { didYouMean: suggestion },
    });
  }
  const rest = first === -1 ? "" : ref.slice(first + 1);
  if (rest === "") throw new CliError("usage", `ref "${ref}" names no ${kind}`, { hints: [`pmcp ${verb} ${kind}/<slug>`] });
  const second = rest.indexOf("/");
  return second === -1
    ? { kind, slug: rest }
    : { kind, slug: rest.slice(0, second), item: rest.slice(second + 1) };
}

/** The four catalog families §20.2 defines, and the key each one is addressed by. */
const FAMILIES = [
  { key: "tools", label: "tools", singular: "tool", method: "tools/list", resultKey: "tools", idOf: (item: Record<string, any>) => String(item.name) },
  { key: "prompts", label: "prompts", singular: "prompt", method: "prompts/list", resultKey: "prompts", idOf: (item: Record<string, any>) => String(item.name) },
  { key: "resources", label: "resources", singular: "resource", method: "resources/list", resultKey: "resources", idOf: (item: Record<string, any>) => String(item.uri) },
  {
    key: "resourceTemplates",
    label: "templates",
    singular: "template",
    method: "resources/templates/list",
    resultKey: "resourceTemplates",
    idOf: (item: Record<string, any>) => String(item.uriTemplate),
  },
] as const;

type Catalog = Record<string, Record<string, any>[]>;

/**
 * All four gateway lists for one app. A family the app does not serve answers
 * `-32601` (§20.2's method-not-found) and becomes an empty array rather than a failure —
 * `describe` is family-agnostic and prints `(none)` for what is absent.
 */
async function readCatalog(ctx: CliContext, slug: string): Promise<Catalog> {
  const entries = await Promise.all(
    FAMILIES.map(async (family) => {
      try {
        const result = (await rpc(ctx, scoped(ctx, slug), family.method)) as Record<string, unknown>;
        return [family.key, ((result?.[family.resultKey] ?? []) as Record<string, any>[])] as const;
      } catch (error) {
        if (error instanceof HubRpcError && error.code === HUB_ERRORS.methodNotFound) return [family.key, []] as const;
        throw error;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * `pmcp describe <ref>` — §10's one exploration verb. `app/<slug>` renders from the
 * four GATEWAY list calls alone, so it works with any token including a `pmcp_agt_` key; its
 * kind/status/roles header is a best-effort admin read that degrades to the bare slug when
 * refused. `app/<slug>/<item>` matches tools and prompts by name, resources by `uri`
 * and templates by `uriTemplate`, and prints EVERY match. `agent/<slug>` composes
 * `agent_list` + `token_list` — the same reads the admin commands already make.
 */
export async function describe(ctx: CliContext, ref: Ref): Promise<number> {
  if (ref.kind === "agent") return describeAgent(ctx, ref.slug);
  const catalog = await readCatalog(ctx, ref.slug);
  if (ref.item !== undefined) return describeItem(ref.slug, ref.item, catalog);
  // Best effort, and only for the header: an agent can read the catalog above but
  // never `app_list` (§8), and the catalog is the part that matters.
  const row = await appRow(ctx, ref.slug);
  if (globals.json) {
    return emitDocument({
      app: ref.slug,
      ...(row === undefined ? {} : { kind: row.kind, status: statusOf(row), roles: Object.keys(row.roles ?? {}), archived: row.archived }),
      tools: catalog.tools,
      prompts: catalog.prompts,
      resources: catalog.resources,
      resourceTemplates: catalog.resourceTemplates,
    });
  }
  const c = styling(decorated());
  write(
    row === undefined
      ? `${c.bold(ref.slug)}\n`
      : `${c.bold(ref.slug)} — ${row.kind}, ${statusOf(row)} — roles: ${declaredRoles(row)}${row.archived ? " (archived)" : ""}\n`,
  );
  if (row !== undefined && row.kind === "tunnel" && row.status !== "online") {
    write(`${c.yellow("offline — catalog from last connection")}\n`);
  }
  const empty: string[][] = [];
  for (const family of FAMILIES) {
    const items = catalog[family.key];
    if (items.length === 0) {
      empty.push([family.label, "(none)"]);
      continue;
    }
    write(`\n${c.dim(family.label)}\n`);
    for (const item of items) {
      write(`  ${catalogLine(family.idOf(item), String(item.description ?? item.name ?? ""), 18, decorated())}\n`);
    }
  }
  if (empty.length > 0) write(`\n${columnize(empty, { tty: decorated() })}\n`);
  write(`\npmcp describe app/${ref.slug}/<item> shows an item's full shape\n`);
  return 0;
}

/** The admin row behind an app, or undefined when the caller may not read one (§8). */
async function appRow(ctx: CliContext, slug: string): Promise<AppRow | undefined> {
  try {
    return rows<AppRow>(await adminOp(ctx, "app_list"), "apps").find((row) => row.slug === slug);
  } catch {
    return undefined;
  }
}

/** Every family match for one item id, printed under its family header; none is `not_found`. */
function describeItem(slug: string, item: string, catalog: Catalog): number {
  const matches = FAMILIES.flatMap((family) =>
    catalog[family.key].filter((entry) => family.idOf(entry) === item).map((entry) => ({ family, entry })),
  );
  if (matches.length === 0) {
    const all = FAMILIES.flatMap((family) => catalog[family.key].map((entry) => ({ id: family.idOf(entry), family })));
    const suggestion = didYouMean(item, all.map((candidate) => candidate.id));
    const closest = all.find((candidate) => candidate.id === suggestion);
    throw new CliError(
      "not_found",
      `nothing named "${item}" on ${slug} (searched ${FAMILIES.map((family) => family.label).join(", ")})`,
      {
        detail: closest === undefined ? [] : [`closest: ${closest.id} (${closest.family.singular})`],
        hints: [`pmcp describe app/${slug} lists everything`],
        extra: closest === undefined ? undefined : { didYouMean: closest.id },
      },
    );
  }
  if (globals.json) {
    return emitDocument({
      app: slug,
      matches: matches.map(({ family, entry }) => ({ family: family.key, ...entry })),
    });
  }
  const c = styling(decorated());
  matches.forEach(({ family, entry }, index) => {
    if (index > 0) write("\n");
    write(`${c.bold(family.idOf(entry))} — ${family.singular} on ${slug}\n`);
    if (typeof entry.description === "string" && entry.description !== "") {
      write(`\n${wrapText(entry.description, 78, 2)}\n`);
    }
    for (const [label, value] of [["uri", entry.uri], ["uriTemplate", entry.uriTemplate], ["name", entry.name], ["mimeType", entry.mimeType]] as const) {
      if (family.key === "tools" || family.key === "prompts") break;
      if (typeof value === "string" && value !== "") write(`\n${label}\n  ${value}\n`);
    }
    if (Array.isArray(entry.arguments)) {
      write(`\n${c.dim("arguments")}\n`);
      write(
        `${indent(
          columnize(
            (entry.arguments as Record<string, any>[]).map((argument) => [
              String(argument.name),
              argument.required === true ? "required" : "",
              String(argument.description ?? ""),
            ]),
            { tty: decorated() },
          ),
          2,
        )}\n`,
      );
    }
    if (entry.inputSchema !== undefined) {
      write(`\n${c.dim("arguments")}\n${indent(schemaTable(entry.inputSchema, decorated()), 2)}\n`);
    }
    if (entry.outputSchema !== undefined) {
      write(`\n${c.dim("returns")}\n${indent(schemaTable(entry.outputSchema, decorated()), 2)}\n`);
    }
  });
  return 0;
}

/** Split the wire's trailing `:approval` mode suffix without touching colons inside an inline URI. */
function splitGrant(entry: string): { role: string; mode: "allow" | "approval" } {
  const suffix = ":approval";
  return entry.endsWith(suffix)
    ? { role: entry.slice(0, -suffix.length), mode: "approval" }
    : { role: entry, mode: "allow" };
}

/** `describe agent/<slug>` — agent_list + token_list, the same reads admin already makes. */
async function describeAgent(ctx: CliContext, slug: string): Promise<number> {
  const found = rows<AgentRow>(await adminOp(ctx, "agent_list"), "agents").find((row) => row.slug === slug);
  if (found === undefined) {
    throw new CliError("not_found", `no agent "${slug}"`, { hints: ["pmcp agent list"] });
  }
  const tokens = rows<Record<string, any>>(await adminOp(ctx, "token_list"), "tokens").filter(
    (row) => row.kind === "agent" && row.refSlug === slug,
  );
  if (globals.json) return emitDocument({ agent: found, tokens });
  const c = styling(decorated());
  write(`${c.bold(slug)} — agent\n`);
  const grants = Object.entries(found.grants).flatMap(([app, roles]) =>
    roles.map((role) => {
      const split = splitGrant(role);
      return [app, split.role, split.mode];
    }),
  );
  write(`\n${c.dim("grants")}\n${indent(grants.length === 0 ? "(none)" : columnize(grants, { tty: decorated() }), 2)}\n`);
  const tokenRows = tokens.map((row) => [
    String(row.id),
    String(row.prefix ?? ""),
    `expires ${row.expiresAt === null || row.expiresAt === undefined ? "never" : formatDate(Number(row.expiresAt))}`,
    `last used ${row.lastUsedAt === null || row.lastUsedAt === undefined ? "never" : formatDate(Number(row.lastUsedAt))}`,
  ]);
  write(`\n${c.dim("tokens")}\n${indent(tokenRows.length === 0 ? "(none)" : columnize(tokenRows, { tty: decorated() }), 2)}\n`);
  return 0;
}

// ── the imperative admin families ──────────────────────────────────────────────────────

/**
 * One imperative app command, normalized from `pmcp app …` argv by
 * main. `create` of a tunneled app is two tool calls — app_create,
 * then token_issue — because a tunneled app is unusable without its token
 * (§6 lifecycle); proxied create carries endpoint + auth mode instead.
 * `typescriptAliases` is §23.6's owner lane, passed through verbatim on create;
 * `set-aliases` is the same object through `app_update`, the only write that
 * can change an established assignment (omission there preserves it).
 * `set-auth` holds the full replacement header set (repeatable `--header`
 * flags, write-only, headers-mode apps only, §8); `disconnect` wipes an
 * OAuth bundle (`auth: oauth` only).
 */
export type AppCommand =
  | { sub: "create"; slug: string; kind: "tunnel"; typescriptAliases?: Record<string, unknown> }
  | {
      sub: "create";
      slug: string;
      kind: "proxy";
      endpoint: string;
      auth: "headers" | "oauth";
      typescriptAliases?: Record<string, unknown>;
    }
  | { sub: "set-aliases"; slug: string; typescriptAliases: Record<string, unknown> }
  | { sub: "archive" | "unarchive" | "delete" | "disconnect"; slug: string }
  | { sub: "set-auth"; slug: string; headers: Record<string, string> };

/**
 * `pmcp app …` — the one-off actions the web UI does with buttons (§10);
 * declarative management belongs to diff/apply. Each sub maps onto its §8
 * tool. Tunneled `create` prints the minted app token exactly once — the
 * CLI never stores it. `delete` is destructive (grants cascade, tokens
 * deleted, socket severed — all server-side effects) and asks for
 * confirmation unless `--yes`. The reserved `pmcp` slug is rejected uniformly by
 * the server; no client-side gate duplicates that.
 */
export async function app(ctx: CliContext, cmd: AppCommand): Promise<number> {
  // deps: mcpCall · confirm
  if (cmd.sub === "create") {
    const created = await adminOp(ctx, "app_create", {
      slug: cmd.slug,
      kind: cmd.kind,
      ...(cmd.kind === "proxy" ? { endpoint: cmd.endpoint, auth: cmd.auth } : {}),
      // Absent flag = absent field: §23.6's omission rule is the hub's to enforce, and an
      // empty object invented here would read as a deliberate clear.
      ...(cmd.typescriptAliases === undefined ? {} : { typescript_aliases: cmd.typescriptAliases }),
    });
    // A tunneled app is unusable without its credential (§6): mint it here, print once.
    const minted = cmd.kind === "tunnel" ? await adminOp(ctx, "token_issue", { kind: "app", slug: cmd.slug }) : undefined;
    if (globals.json) return emitDocument({ app: created.app ?? { slug: cmd.slug }, ...(minted === undefined ? {} : { token: minted }) });
    write(`created ${String((created.app as Record<string, unknown>)?.slug ?? cmd.slug)}\n`);
    if (minted !== undefined) write(`app token (shown once): ${String(minted.token)}\n`);
    return 0;
  }
  if (cmd.sub === "set-aliases") {
    const updated = await adminOp(ctx, "app_update", { slug: cmd.slug, typescript_aliases: cmd.typescriptAliases });
    // `--json` is the op's own document (`{ app }`, §08) — the row carries the owner
    // configuration, the resolved map, and the diagnostics, so the machine stream is the
    // whole answer rather than an echo of what was typed.
    if (globals.json) return emitDocument(updated);
    write(`typescript aliases set for ${cmd.slug}\n`);
    writeAliasMapping((updated.app ?? {}) as Record<string, unknown>);
    return 0;
  }
  if (cmd.sub === "set-auth") {
    await adminOp(ctx, "app_set_upstream_auth", { slug: cmd.slug, headers: cmd.headers });
    if (globals.json) return emitDocument({ slug: cmd.slug, headers: Object.keys(cmd.headers) });
    write(`upstream headers replaced for ${cmd.slug}\n`);
    return 0;
  }
  if (cmd.sub === "delete" && !globals.yes) {
    if (!(await confirm(`delete ${cmd.slug}? its grants cascade and its tokens are deleted`))) return 1;
  }
  const op = { archive: "app_archive", unarchive: "app_unarchive", delete: "app_delete", disconnect: "app_disconnect" }[
    cmd.sub
  ];
  await adminOp(ctx, op, { slug: cmd.slug });
  if (globals.json) return emitDocument({ slug: cmd.slug, action: cmd.sub });
  write(`${cmd.sub} ${cmd.slug}\n`);
  return 0;
}

/**
 * The mapping body §10 asks alias commands for: every resolved reservation as
 * `family  canonical → TypeScript (source)`, tombstones marked `superseded` — the old path
 * stays reserved (§23.6), so the operator needs to see why it is still listed — followed by
 * the bounded collision/omission diagnostics the hub attached. Both lists are read from the
 * `app_update` row (§08 exposes owner configuration separately from the resolved map); a
 * row carrying neither prints nothing rather than guessing at a shape.
 */
function writeAliasMapping(row: Record<string, unknown>): void {
  // `Array.isArray` narrows each read to `any[]` before the named const, so a shape the hub
  // did not send renders as an empty list rather than as an unchecked member access.
  const reservations: Record<string, any>[] = Array.isArray(row.typescriptReservations) ? row.typescriptReservations : [];
  if (reservations.length > 0) {
    const lines = reservations.map((entry) => [
      String(entry.family ?? ""),
      String(entry.canonicalName ?? ""),
      "→",
      String(entry.typescriptName ?? ""),
      `(${entry.active === false ? "superseded" : String(entry.source ?? "")})`,
    ]);
    write(`${indent(columnize(lines, { tty: decorated() }), 2)}\n`);
  }
  const diagnostics: Record<string, any>[] = Array.isArray(row.typescriptDiagnostics) ? row.typescriptDiagnostics : [];
  for (const entry of diagnostics) {
    write(`  ${String(entry.reason ?? "alias")}: ${String(entry.family ?? "")} ${String(entry.canonicalName ?? "")} — ${String(entry.message ?? "")}\n`);
  }
}

/** One agent command, normalized from `pmcp agent …` argv. */
export type AgentCommand =
  | { sub: "list" }
  | { sub: "create"; slug: string; name?: string; description?: string }
  | { sub: "update"; slug: string; name?: string; description?: string }
  | { sub: "delete"; slug: string };

/**
 * `pmcp agent …` — sugar over agent_list / agent_create / agent_update /
 * agent_delete (§8). `list` prints each agent with its grants inline (per
 * app: role names and modes). `update` patches `name`/`description`; `slug`
 * is immutable (§22.4). `delete` is destructive — grants cascade and the
 * agent's tokens are deleted server-side — and asks for confirmation unless `--yes`.
 */
export async function agent(ctx: CliContext, cmd: AgentCommand): Promise<number> {
  // deps: mcpCall · confirm
  if (cmd.sub === "list") {
    const agents = rows<AgentRow>(await adminOp(ctx, "agent_list"), "agents");
    if (globals.json) return emitDocument({ agents });
    const table = columnize(
      agents.map((row) => [
        row.slug,
        Object.entries(row.grants)
          .map(([app, roles]) => `${app}=[${roles.join(",")}]`)
          .join(" ") || "(no grants)",
      ]),
      { headers: ["AGENT", "GRANTS"], tty: decorated() },
    );
    write(`${table}\n`);
    return 0;
  }
  if (cmd.sub === "create") {
    const created = await adminOp(ctx, "agent_create", {
      slug: cmd.slug,
      ...(cmd.name === undefined ? {} : { name: cmd.name }),
      ...(cmd.description === undefined ? {} : { description: cmd.description }),
    });
    if (globals.json) return emitDocument(created);
    write(`created ${cmd.slug}\n`);
    return 0;
  }
  if (cmd.sub === "update") {
    // No fields given is legal — agent_update's own no-op (§22.4): the hub leaves the
    // row unchanged and returns it, so this prints the same success line either way.
    const updated = await adminOp(ctx, "agent_update", {
      slug: cmd.slug,
      ...(cmd.name === undefined ? {} : { name: cmd.name }),
      ...(cmd.description === undefined ? {} : { description: cmd.description }),
    });
    if (globals.json) return emitDocument(updated);
    write(`updated ${cmd.slug}\n`);
    return 0;
  }
  if (!globals.yes) {
    if (!(await confirm(`delete agent ${cmd.slug}? its grants cascade and its tokens are deleted`))) return 1;
  }
  await adminOp(ctx, "agent_delete", { slug: cmd.slug });
  if (globals.json) return emitDocument({ slug: cmd.slug, action: "delete" });
  write(`deleted ${cmd.slug}\n`);
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
 * front). The rendering reads the WIRE's own field names — `agentSlug`,
 * `appSlug`, `args` (approvals.ApprovalRow) — and prefixes `agent:` client-side, so the
 * WHO/WHAT columns carry what the hub actually sent.
 */
export async function approval(ctx: CliContext, cmd: ApprovalCommand): Promise<number> {
  // deps: mcpCall
  if (cmd.sub !== "list") {
    const decided = await withIdPrefix(ctx, cmd.id, { op: "approval_list", key: "approvals" }, (id) =>
      adminOp(ctx, "approval_decide", { id, decision: cmd.sub }),
    );
    if (globals.json) return emitDocument(decided);
    write(`${String(decided.decision ?? cmd.sub)} ${String(decided.id ?? cmd.id)}\n`);
    return 0;
  }
  // `--history` is a CLIENT-side selection: approval_list's `status` is the wire enum
  // (pending/approved/rejected/expired/used) and has no "decided" member, so asking the hub
  // for one is a frame it can only refuse (§8's op schema).
  const listed = await adminOp(ctx, "approval_list", cmd.filter === "pending" ? { status: "pending" } : {});
  const approvals = ((listed.approvals ?? listed.rows ?? []) as Record<string, any>[]).filter(
    (row) => cmd.filter !== "history" || String(row.status ?? "") !== "pending",
  );
  if (globals.json) return emitDocument({ approvals });
  const c = styling(decorated());
  const table = columnize(
    approvals.flatMap((row) => [
      [String(row.id), String(row.status ?? ""), `agent:${String(row.agentSlug ?? "")} → ${String(row.appSlug ?? "")}/${String(row.tool ?? "")}`],
      ["", "", `args ${JSON.stringify(row.args ?? {})} · ${expiryPhrase(row.expiresAt)}`],
    ]),
    { headers: ["APPROVAL", "STATUS", "WHO → WHAT"], tty: decorated() },
  ).split("\n");
  write(`${c.dim(table[0])}\n`);
  for (const line of table.slice(1)) write(`${line.trimEnd()}\n`);
  return 0;
}

/**
 * The mutating verbs accept any unambiguous id PREFIX (§10's `ambiguous_id` code, mock §6),
 * resolved on the ERROR path only: the typed id goes out exactly as typed, and only a
 * refusal buys the one list call that turns a prefix into the full id. Nothing is retried
 * after a mutation that landed — the retry happens only because the first attempt failed —
 * and an id that is already exact, or a refusal about something other than the id, rethrows
 * the hub's own error untouched.
 */
async function withIdPrefix<T>(
  ctx: CliContext,
  prefix: string,
  list: { op: string; key: string },
  run: (id: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(prefix);
  } catch (error) {
    if (!(error instanceof HubRpcError)) throw error;
    const ids = await idsMatching(ctx, prefix, list);
    if (ids.length === 0 || ids[0] === prefix) throw error;
    if (ids.length > 1) {
      throw new CliError("ambiguous_id", `"${prefix}" matches ${ids.length} ids`, {
        detail: ids,
        hints: ["pass more of the id"],
      });
    }
    return run(ids[0]);
  }
}

/** The ids one list op carries that start with `prefix`, or none when the list itself failed. */
async function idsMatching(ctx: CliContext, prefix: string, list: { op: string; key: string }): Promise<string[]> {
  try {
    return rows<Record<string, unknown>>(await adminOp(ctx, list.op), list.key)
      .map((row) => String(row.id ?? ""))
      .filter((id) => id !== "" && id.startsWith(prefix));
  } catch {
    return [];
  }
}

/** An ISO-8601 expiry as the humane phrase the mock prints — `expires in 9m`, or a date. */
function expiryPhrase(expiresAt: unknown): string {
  if (typeof expiresAt !== "string" || expiresAt === "") return "no expiry";
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return `expires ${expiresAt}`;
  const minutes = Math.round((at - Date.now()) / 60_000);
  if (minutes < 0) return "expired";
  return minutes < 60 ? `expires in ${minutes}m` : `expires ${formatDateTime(at)}`;
}

/**
 * One token command, normalized from `pmcp token …` argv: `issue` targets a
 * agent or a (tunneled) app by slug; `expires` arrives ALREADY
 * RESOLVED by main's expiresIn to what token_issue declares — a count of
 * SECONDS of lifetime, or the literal `never` — so the human spelling "90d"
 * never reaches this type (defaults differ by kind, §5).
 */
export type TokenCommand =
  | { sub: "issue"; kind: "agent" | "app"; slug: string; expires?: number | "never" }
  | { sub: "list" }
  | { sub: "revoke"; id: string };

/**
 * `pmcp token …` — sugar over token_issue / token_list / token_revoke (§8).
 * `issue` prints the plaintext key exactly once and the CLI never stores it.
 * `list` shows prefix, expiry, and the coarse last_used_at that makes
 * rotation state observable (§5). Revoking an app token also severs that
 * app's live socket — a server-side effect, merely reported here.
 */
export async function token(ctx: CliContext, cmd: TokenCommand): Promise<number> {
  // deps: mcpCall
  if (cmd.sub === "issue") {
    const minted = await adminOp(ctx, "token_issue", {
      kind: cmd.kind,
      slug: cmd.slug,
      ...(cmd.expires === undefined ? {} : { expires_in: cmd.expires }),
    });
    if (globals.json) return emitDocument(minted);
    write(`${String(minted.id)}\n${String(minted.token)}\n`);
    return 0;
  }
  if (cmd.sub === "revoke") {
    const id = await withIdPrefix(ctx, cmd.id, { op: "token_list", key: "tokens" }, async (resolved) => {
      await adminOp(ctx, "token_revoke", { id: resolved });
      return resolved;
    });
    if (globals.json) return emitDocument({ id, revoked: true });
    write(`revoked ${id}\n`);
    return 0;
  }
  const tokens = rows<Record<string, any>>(await adminOp(ctx, "token_list"), "tokens");
  if (globals.json) return emitDocument({ tokens });
  const c = styling(decorated());
  const table = columnize(
    tokens.map((row) => [
      String(row.id),
      String(row.prefix ?? ""),
      row.expiresAt === null || row.expiresAt === undefined ? "never" : formatDate(Number(row.expiresAt)),
      row.lastUsedAt === null || row.lastUsedAt === undefined ? "never" : formatDateTime(Number(row.lastUsedAt)),
    ]),
    { headers: ["TOKEN", "PREFIX", "EXPIRES", "LAST USED"], tty: decorated() },
  ).split("\n");
  write(`${c.dim(table[0])}\n`);
  for (const line of table.slice(1)) write(`${line}\n`);
  return 0;
}

/**
 * One admin-token command, normalized from `pmcp admin-token …` argv (§22.1). `issue`
 * requires a signed-in session — an admin token cannot mint a successor, refused
 * server-side by admin.adminOpsFor, not here — and `expires` arrives already resolved
 * by main's expiresIn to what admin_token_issue declares: a count of SECONDS, or the
 * literal `never`, so the human spelling "365d" never reaches this type.
 */
export type AdminTokenCommand =
  | { sub: "issue"; expires?: number | "never" }
  | { sub: "list" }
  | { sub: "revoke"; id: string };

/**
 * `pmcp admin-token …` — sugar over admin_token_issue / admin_token_list /
 * admin_token_revoke (§22.1). `issue` prints the plaintext key exactly once and the CLI
 * never stores it, exactly like `token issue`. Unlike agent/app keys, an admin token
 * opens no socket, so `revoke` reports only the row.
 */
export async function adminToken(ctx: CliContext, cmd: AdminTokenCommand): Promise<number> {
  // deps: mcpCall
  if (cmd.sub === "issue") {
    const minted = await adminOp(ctx, "admin_token_issue", cmd.expires === undefined ? {} : { expires_in: cmd.expires });
    if (globals.json) return emitDocument(minted);
    write(`${String(minted.id)}\n${String(minted.token)}\n`);
    return 0;
  }
  if (cmd.sub === "revoke") {
    const id = await withIdPrefix(ctx, cmd.id, { op: "admin_token_list", key: "tokens" }, async (resolved) => {
      await adminOp(ctx, "admin_token_revoke", { id: resolved });
      return resolved;
    });
    if (globals.json) return emitDocument({ id, revoked: true });
    write(`revoked ${id}\n`);
    return 0;
  }
  const tokens = rows<Record<string, any>>(await adminOp(ctx, "admin_token_list"), "tokens");
  if (globals.json) return emitDocument({ tokens });
  const c = styling(decorated());
  const table = columnize(
    tokens.map((row) => [
      String(row.id),
      String(row.prefix ?? ""),
      row.expiresAt === null || row.expiresAt === undefined ? "never" : formatDate(Number(row.expiresAt)),
      row.lastUsedAt === null || row.lastUsedAt === undefined ? "never" : formatDateTime(Number(row.lastUsedAt)),
    ]),
    { headers: ["TOKEN", "PREFIX", "EXPIRES", "LAST USED"], tty: decorated() },
  ).split("\n");
  write(`${c.dim(table[0])}\n`);
  for (const line of table.slice(1)) write(`${line}\n`);
  return 0;
}

/**
 * Filters for `pmcp audit`, mirroring audit_query's parameters (§8) with CLI
 * sugar main resolves before the call: `agent` becomes principal
 * `"agent:<slug>"`; `since`/`until` arrive ALREADY RESOLVED by main's instantMs to
 * the epoch MS audit_query declares, so the human spellings it accepts (a "7d"
 * duration ago, an ISO instant, a bare epoch) never reach this type. `limit` is
 * the page (and export chunk) size, server default 100.
 */
export type AuditFilters = {
  agent?: string;
  app?: string;
  event?: string;
  tool?: string;
  session?: string;
  since?: number;
  until?: number;
  limit?: number;
};

/**
 * `pmcp audit` — audit_query presentation (§8). Default: one page as a table,
 * newest first, plus the "N of M events match" line from `total`; the timestamp column is
 * the wire's epoch-ms `ts` (§8's AuditRow) formatted locally. Recorded bodies (§15 —
 * post-redaction and stub-substituted, the only stored form) render in a row's detail, with
 * stubs shown as typed size placeholders (`‹blob image/png · 4.2 MB›`), never raw.
 * `exportJsonl` instead streams EVERY matching row to stdout, one JSON object per line —
 * bodies included verbatim as stored — by re-querying in limit-sized chunks, never held in
 * memory at once. Exit 0 even when nothing matches.
 */
export async function audit(
  ctx: CliContext,
  filters: AuditFilters,
  opts: { exportJsonl?: boolean },
): Promise<number> {
  // deps: mcpCall
  const query: Record<string, unknown> = {
    ...(filters.agent === undefined ? {} : { principal: `agent:${filters.agent}` }),
    ...(filters.app === undefined ? {} : { app: filters.app }),
    ...(filters.event === undefined ? {} : { event: filters.event }),
    ...(filters.tool === undefined ? {} : { tool: filters.tool }),
    ...(filters.session === undefined ? {} : { session: filters.session }),
    ...(filters.since === undefined ? {} : { since: filters.since }),
    ...(filters.until === undefined ? {} : { until: filters.until }),
    ...(filters.limit === undefined ? {} : { limit: filters.limit }),
  };
  if (opts.exportJsonl !== true) {
    const page = await adminOp(ctx, "audit_query", query);
    const auditRows = (page.rows ?? []) as Record<string, unknown>[];
    if (globals.json) return emitDocument({ rows: auditRows, total: Number(page.total ?? 0) });
    if (auditRows.length > 0) {
      write(
        `${columnize(
          auditRows.map((row) => [
            // The wire sends epoch-ms `ts` (§8's AuditRow); the event vocabulary —
            // `tools/call`, `admin.<tool>`, `connect.register` — prints verbatim.
            formatDateTime(Number(row.ts ?? 0)),
            String(row.principal ?? ""),
            String(row.event ?? ""),
            `${String(row.app ?? "")}${row.tool === undefined ? "" : `/${String(row.tool)}`}`,
            `${String(row.outcome ?? "")}${renderBodies(row)}`,
          ]),
          { tty: decorated() },
        )}\n`,
      );
    }
    write(`${auditRows.length} of ${Number(page.total ?? 0)} events match\n`);
    return 0;
  }
  // The export re-queries in chunks and writes each as it arrives: the same rows as the
  // web export, never the whole result set in memory.
  const size = filters.limit ?? 100;
  for (let offset = 0; ; offset += size) {
    const page = await adminOp(ctx, "audit_query", { ...query, limit: size, offset });
    const chunk = (page.rows ?? []) as unknown[];
    for (const row of chunk) write(`${JSON.stringify(row)}\n`);
    if (chunk.length < size) return 0;
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

/** Epoch ms → `YYYY-MM-DD` / `YYYY-MM-DD HH:MM`, UTC, so a table column is fixed width. */
function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatDateTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}


/**
 * `pmcp connect <app>` — prints the /apps OAuth connect URL for an
 * `auth: oauth` proxied app (§7, §10). The consent redirect is inherently
 * a browser interaction (§8 pins Connect outside the tool surface), so
 * printing the URL is the whole command — the CLI never runs the flow. Checks
 * the slug via app_get first, so a typo or a headers-mode app fails
 * here, not in the browser.
 */
export async function connect(ctx: CliContext, app: string): Promise<number> {
  // deps: mcpCall
  const row = ((await adminOp(ctx, "app_get", { slug: app })).app ?? {}) as Record<string, unknown>;
  if (row.kind !== "proxy" || row.auth !== "oauth") {
    throw new CliError("invalid_arguments", `${app} is not an \`auth: oauth\` proxied app — nothing to connect`, {
      hints: ["pmcp ls lists your apps"],
    });
  }
  const url = `${ctx.origin}/apps?connect=${encodeURIComponent(app)}`;
  if (globals.json) return emitDocument({ app, connectUrl: url });
  write(`${url}\n`);
  return 0;
}

/**
 * One connection command, normalized from `pmcp connection(s) …` argv (§10, §19). `list`
 * has no sub-argv of its own — `pmcp connections` is the whole command, mirroring `pmcp
 * ls` — while `revoke` takes the connection id `connections` prints.
 */
export type ConnectionCommand = { sub: "list" } | { sub: "revoke"; id: string };

/**
 * `pmcp connections | connection revoke <id>` — sugar over connection_list /
 * connection_revoke (§8/§19, §10): the OAuth clients (claude.ai and friends) connected to
 * this namespace via §19's inbound authorization server — a DISTINCT thing from `connect`'s
 * outbound upstream-OAuth URL above. `list` prints each binding the namespace holds — live
 * and revoked alike, since §13's Connected clients pane keeps a revoked row and
 * `connection_list` therefore no longer filters them out: the client's name (its id, when it
 * registered without one, §19.3), the agent it is bound to, its created/last-used timestamps,
 * and the `active` | `revoked` STATUS the pane derives from the same `revokedAt` stamp (the op
 * speaks timestamps, both readers spell the state) — never a token, a client secret, or a JWT,
 * because a connection is a binding and a binding holds no credential (§8). `revoke` is
 * immediate at the door (§19.6): the connection's next call gets the 401 challenge, and the
 * client's consent is gone too, so a refresh cannot resurrect it silently.
 */
export async function connection(ctx: CliContext, cmd: ConnectionCommand): Promise<number> {
  // deps: mcpCall
  if (cmd.sub === "revoke") {
    const id = await withIdPrefix(ctx, cmd.id, { op: "connection_list", key: "connections" }, async (resolved) => {
      await adminOp(ctx, "connection_revoke", { id: resolved });
      return resolved;
    });
    if (globals.json) return emitDocument({ id, revoked: true });
    write(`revoked ${id}\n`);
    return 0;
  }
  const connections = rows<Record<string, any>>(await adminOp(ctx, "connection_list"), "connections");
  if (globals.json) return emitDocument({ connections });
  const c = styling(decorated());
  const table = columnize(
    connections.map((row) => [
      String(row.id),
      String(row.clientName ?? row.clientId),
      String(row.agentSlug ?? ""),
      row.createdAt === null || row.createdAt === undefined ? "" : formatDateTime(Number(row.createdAt)),
      row.lastUsedAt === null || row.lastUsedAt === undefined ? "never" : formatDateTime(Number(row.lastUsedAt)),
      row.revokedAt === null || row.revokedAt === undefined ? "active" : "revoked",
      // G29 (2026-09-03): the two facts a reader wants first when a row looks unfamiliar —
      // where the client lives, and whether anyone vouched for it at registration (§19.3).
      String(row.redirectOrigin ?? ""),
      row.selfRegistered === true ? "yes" : "",
    ]),
    {
      headers: ["CONNECTION", "CLIENT", "AGENT", "CREATED", "LAST USED", "STATUS", "ORIGIN", "SELF-REGISTERED"],
      tty: decorated(),
    },
  ).split("\n");
  write(`${c.dim(table[0])}\n`);
  for (const line of table.slice(1)) write(`${line}\n`);
  return 0;
}

// ── the command table (§8 parity, direction D) ─────────────────────────────────────────

// The table itself lives in ./commands.ts — a module with no imports, so the parity suite
// reads the same data this dispatcher uses without loading the CLI's filesystem access
// into workerd. Re-exported so a CLI consumer still finds it where the surface lives.
export { COMMANDS } from "./commands.ts";
export type { CliCommand } from "./commands.ts";

// ── argv → one invocation ──────────────────────────────────────────────────────────────

/** §10's grouped overview, printed by `pmcp` and `pmcp help` before anything is resolved. */
const OVERVIEW = `pmcp — personal MCP hub CLI

Explore
  ls                          apps with kind, status, and your roles
  describe <ref>              app/<slug>[/<item>] or agent/<slug>

Invoke
  call <app> <tool> [key=value … | --args '{…}']
  get prompt/<app>/<name> [key=value … | --args '{…}']
  get resource/<app>/<uri>

Hub
  hub execute --args '{…}' · hub search-types --args '{…}'
  hub settings get | set --default-timeout-ms <int> --max-timeout-ms <int>

Auth & profiles
  login [--profile <name>] [--url <origin>]
  logout · whoami
  profile add|list|use|remove

Admin
  app create|archive|unarchive|delete|disconnect|set-auth
  app aliases set <slug> [--args '{…}']
  agent list|create|update|delete
  approvals · approve <id> · reject <id>
  token issue|list|revoke · admin-token issue|list|revoke
  connect <app> · connections · connection revoke <id>
  audit [--export jsonl]

Global: --profile <name>, --json, --no-color, --yes, --version, -h
`;

/**
 * Process entry: extract the global flags, answer help and `--version` BEFORE any context
 * resolution or network call (§10 — `pmcp tools --help` must never make a whoami first),
 * then let commander dispatch exactly one family invocation. Every failure lands in the one
 * catch below and is rendered by errors.emitError, which owns the grammar and the exit
 * code: `usage` is 2, every other code 1, and a plain thrown Error becomes `remote_error`.
 */
export async function main(argv: string[]): Promise<number> {
  // deps: commander · resolveContext · every exported command above · errors.emitError
  globals = extractGlobals(argv);
  pendingExit = 0;
  const words = globals.words;
  if (words.length === 0 || words[0] === "help" || words[0] === "--help" || words[0] === "-h") {
    write(OVERVIEW);
    return 0;
  }
  if (words[0] === "--version" || words[0] === "-V") {
    write(`${VERSION}\n`);
    return 0;
  }
  try {
    await buildProgram().parseAsync(words, { from: "user" });
    return pendingExit;
  } catch (error) {
    if (error instanceof CommanderError) {
      // `-h` on a subcommand has already printed its help: that is a success, not a failure.
      if (error.exitCode === 0) return 0;
      // A command family invoked with no subcommand (`pmcp token`) is commander asking for
      // help, which it writes to stderr with a non-zero status. §10 says help is help: it
      // goes to stdout and exits 0, like every other spelling of `-h`.
      if (error.code === "commander.help") {
        write(commanderOut);
        return 0;
      }
      const [message, ...detail] = commanderLines(error);
      return emitError(new CliError("usage", message, { detail, hints: ["pmcp help"] }), {
        json: globals.json,
        stream: process.stderr,
      });
    }
    return emitError(hubErrorToCliError(error), { json: globals.json, stream: process.stderr });
  }
}

/**
 * commander's own prose, stripped of the `error: ` prefix emitError puts back with a code,
 * and split so its second line (`(Did you mean …?)`) becomes INDENTED detail rather than a
 * column-0 line an agent would have to recognize — §8's grammar reserves column 0 for
 * `error:`/`usage:`/`hint:` and nothing else.
 */
function commanderLines(error: CommanderError): [string, ...string[]] {
  const [first, ...rest] = error.message.replace(/^error:\s*/, "").split("\n");
  return [first, ...rest.filter((line) => line.trim() !== "").map((line) => line.trim())];
}

/**
 * A hub refusal that reached the top without command-specific enrichment, mapped onto §10's
 * frozen code vocabulary. Anything else — a CliError, a network exception — passes straight
 * through to emitError, which normalizes what it does not recognize.
 */
function hubErrorToCliError(error: unknown): unknown {
  if (!(error instanceof HubRpcError)) return error;
  if (error.code === HUB_ERRORS.approvalRequired) {
    const data = error.data as ApprovalRequiredData;
    return new CliError("approval_required", `approval required (${data.approvalId})`, {
      detail: [`approve at ${data.approvalUrl}`, `then re-run this exact call before ${data.expiresAt}`],
    });
  }
  if (error.code === HUB_ERRORS.toolNotPermitted) return new CliError("not_found", error.message);
  if (error.code === HUB_ERRORS.invalidParams) return new CliError("invalid_arguments", error.message);
  return new CliError("remote_error", error.message);
}

/**
 * The commander 15 program. Every subcommand is registered here — the 32 legacy spellings
 * (five of them hidden: `tools`, `prompts`, `resources`, `prompt`, `read`, whose documented
 * surface is now `describe`/`get` but whose COMMANDS rows the frozen parity suite still
 * asserts) plus §10's new `profile`, `describe` and `get`, and the guessable noun-verb
 * aliases `app list` / `connection list` / `approval list`.
 *
 * The global flags are NOT declared here: they are positional-free (`pmcp app --yes
 * delete news` and `pmcp app delete news --yes` are one command) and were consumed from
 * argv before commander saw it.
 */
/** Appended to every subcommand's `-h`: the flags stripped from argv before commander parses. */
const GLOBAL_HELP = "\nGlobal: --profile <name>, --json, --no-color, --yes";

function buildProgram(): Command {
  const program = new Command();
  program.name("pmcp").version(VERSION).exitOverride();
  // commander's own stderr prose would duplicate emitError's grammar; the exception it
  // throws carries the same text, and main renders it with a code and an exit status.
  commanderOut = "";
  program.configureOutput({
    writeErr: (text) => {
      commanderOut += text;
    },
  });

  /**
   * One subcommand. `example` becomes the "usage + one example" §10 asks every `-h` to
   * answer with, and is spelled out only where the argv shape is not its own example —
   * `pmcp logout` needs no illustration; `pmcp get resource/notes/file:///todo.md` does.
   */
  const on = (name: string, describe_: string, example?: string, hidden = false): Command => {
    const command = program.command(name, { hidden }).description(describe_);
    const withExample = example === undefined ? command : command.addHelpText("after", `\nExample:\n  ${example}`);
    // The global flags are stripped before commander parses (they are positional-free by
    // contract), so nothing declares them per command — this footer is how `pmcp <cmd> -h`
    // still teaches them (§10: agents learn from help text, not pickers).
    return withExample.addHelpText("after", GLOBAL_HELP);
  };

  on("login", "log in to a hub via the RFC 8628 device flow", "pmcp login --profile work --url https://hub.example.com")
    .option("--url <origin>", "the hub's https origin")
    .action(async (opts: { url?: string }) => {
      pendingExit = (await login(opts.url)) as 0 | 1;
    });
  on("logout", "clear the active profile's token").action(async () => {
    pendingExit = (await logout()) as 0 | 1;
  });
  on("whoami", "print the principal and namespace this token resolves to").action(async () => {
    pendingExit = (await whoami()) as 0 | 1;
  });

  const profiles = on("profile", "manage named hub identities");
  profiles
    .command("add <name>")
    .option("--url <origin>", "the hub's https origin")
    .description("record a hub url under a name (login fills the token)")
    .action(async (name: string, opts: { url?: string }) => {
      // §10's interactivity sentence names two homes for prompts — `login` and `profile
      // add` — and this is the latter's half: ask for the one missing piece on a TTY,
      // refuse as argv anywhere a prompt has nobody to answer it.
      let url = opts.url;
      if (url === undefined && process.stdin.isTTY === true && !globals.json) url = (await askForUrl()).replace(/\/+$/, "");
      if (url === undefined) {
        throw new CliError("usage", "missing --url", { usage: "pmcp profile add <name> --url <origin>" });
      }
      pendingExit = (await profile({ sub: "add", name, url })) as 0 | 1;
    });
  profiles
    .command("list")
    .description("every profile, with the active one marked")
    .action(async () => {
      pendingExit = (await profile({ sub: "list" })) as 0 | 1;
    });
  profiles
    .command("use <name>")
    .description("set the file's default profile")
    .action(async (name: string) => {
      pendingExit = (await profile({ sub: "use", name })) as 0 | 1;
    });
  profiles
    .command("remove <name>")
    .description("delete a profile (the active one needs --yes)")
    .action(async (name: string) => {
      pendingExit = (await profile({ sub: "remove", name })) as 0 | 1;
    });
  // The profile subcommands are registered off `profiles`, not through `on`, so they get
  // the global-flags footer here.
  for (const sub of profiles.commands) sub.addHelpText("after", GLOBAL_HELP);

  on("ls", "apps with kind, status, and your roles", "pmcp ls --json").action(async () => {
    pendingExit = (await ls(await context())) as 0 | 1;
  });

  on("describe [ref]", "app/<slug>[/<item>] or agent/<slug>", "pmcp describe app/mcp-tools/paper_fetch").action(async (ref?: string) => {
    if (ref === undefined) {
      throw new CliError("usage", "missing ref", {
        usage: "pmcp describe <app/<slug>[/<item>] | agent/<slug>>",
        hints: ["pmcp ls lists your apps"],
      });
    }
    // Parsed BEFORE the context, as in `get`/`call`: argument-list evaluation order would
    // otherwise report a malformed ref as whatever the hub said about the token (§10's
    // local-first rule) — and `describe news` with the ref type left off is the likeliest
    // typo on this verb.
    const parsed = parseRef(ref, ["app", "agent"], "describe");
    pendingExit = (await describe(await context(), parsed)) as 0 | 1;
  });

  on("get [ref] [args...]", "prompt/<app>/<name> or resource/<app>/<uri>", "pmcp get resource/notes/file:///todo.md")
    .option("--args <json>", "the arguments object, as JSON")
    .action(async (ref: string | undefined, words: string[], opts: { args?: string }) => {
      if (ref === undefined) {
        throw new CliError("usage", "missing ref", {
          usage: "pmcp get <prompt/<app>/<name> | resource/<app>/<uri>>",
          hints: ["pmcp describe app/<slug> lists what an app serves"],
        });
      }
      const parsed = parseRef(ref, ["prompt", "resource"], "get");
      if (parsed.item === undefined) {
        throw new CliError("usage", `ref "${ref}" names no ${parsed.kind}`, {
          usage: `pmcp get ${parsed.kind}/<app>/<${parsed.kind === "prompt" ? "name" : "uri"}>`,
        });
      }
      if (parsed.kind === "resource") {
        // A trailing word here would be silently dropped — the call executed would differ
        // from the one typed, which is worse than refusing.
        if (words.length > 0 || opts.args !== undefined) {
          throw new CliError("usage", "resources/read takes no arguments", {
            usage: "pmcp get resource/<app>/<uri>",
          });
        }
        pendingExit = (await read(await context(), parsed.slug, parsed.item)) as 0 | 1;
        return;
      }
      // Parsed BEFORE the context: `await context()` is a network whoami, and argument-list
      // evaluation order would otherwise report malformed argv as whatever the hub said
      // about the token (§10 — pure argv mistakes are caught locally, before any network).
      const args = toolArguments(words, opts.args);
      pendingExit = (await prompt(await context(), parsed.slug, parsed.item, args)) as 0 | 1;
    });

  on("call [words...]", "call a tool: <app> <tool>, plus key=value args", "pmcp call mcp-tools paper_fetch url=https://arxiv.org/abs/2408.00001")
    .option("--args <json>", "the arguments object, as JSON")
    .action(async (words: string[], opts: { args?: string }) => {
      // Partitioned by SHAPE, never by count: a word carrying `=` is an argument wherever
      // it sits, so `pmcp call news echo text=hi` is two positionals plus an argument. The
      // target is exactly `<app> <tool>`: the aggregate endpoint no longer serves
      // application tools (§23.1), so an aggregated `<slug>_<tool>` name has no destination
      // and is reported as the missing half of the pair it looks like.
      const positionals = words.filter((word) => !word.includes("="));
      if (positionals.length > 2) {
        throw new CliError("usage", `"${positionals[2]}" is neither an app, a tool, nor key=value`, {
          usage: "pmcp call <app> <tool> [key=value … | --args '{…}']",
        });
      }
      const app = requireWord(positionals[0], "app", "pmcp call <app> <tool> [key=value … | --args '{…}']");
      const tool = requireWord(positionals[1], "tool", "pmcp call <app> <tool> [key=value … | --args '{…}']");
      // Before the context, deliberately: `await context()` is a network whoami, and an
      // argument list evaluates left to right — a malformed `--args` resolved after it would
      // be reported as a hub failure on an unreachable hub (§10's local-first rule).
      const args = toolArguments(words.filter((word) => word.includes("=")), opts.args);
      pendingExit = (await call(await context(), { app, tool }, args)) as 0 | 1;
    });

  on("tools <app>", "list an app's tools", undefined, true).action(async (slug: string) => {
    pendingExit = (await tools(await context(), slug)) as 0 | 1;
  });
  on("prompts <app>", "list an app's prompts", undefined, true).action(async (slug: string) => {
    pendingExit = (await prompts(await context(), slug)) as 0 | 1;
  });
  on("prompt [words...]", "get one prompt", undefined, true)
    .option("--args <json>", "the arguments object, as JSON")
    .action(async (words: string[], opts: { args?: string }) => {
      const positionals = words.filter((word) => !word.includes("="));
      // Whole argv check before the context, as in `get`/`call`: `await context()` is a
      // network whoami, and an argument list evaluates left to right (§10's local-first rule).
      const slug = requireWord(positionals[0], "app", "pmcp prompt <app> <name> [key=value …]");
      const name = requireWord(positionals[1], "prompt name", "pmcp prompt <app> <name> [key=value …]");
      const args = toolArguments(words.filter((word) => word.includes("=")), opts.args);
      pendingExit = (await prompt(await context(), slug, name, args)) as 0 | 1;
    });
  on("resources <app>", "list an app's resources", undefined, true)
    .option("--templates", "list resource templates instead")
    .action(async (slug: string, opts: { templates?: boolean }) => {
      pendingExit = (await resources(await context(), slug, { templates: opts.templates })) as 0 | 1;
    });
  on("read [words...]", "read one resource", undefined, true).action(async (words: string[]) => {
    if (words.length >= 2) {
      pendingExit = (await read(await context(), words[0], words[1])) as 0 | 1;
      return;
    }
    // §20.2: resources have no aggregated endpoint, so a lone word here is ambiguous only
    // in FORM, never in meaning. One that looks like a URI means the app was left out —
    // this would have addressed the aggregate, which §20.2 refuses, and the refusal reason
    // travels with it so the operator is not sent looking for a slug that does not exist.
    // Anything else means the uri was left out, an ordinary usage error.
    if (words.length === 1 && words[0].includes("://")) {
      throw new CliError(
        "usage",
        "pmcp read needs a <app> before the uri — resources are scoped-only, there is no aggregated endpoint for them (§20.2)",
        { usage: "pmcp read <app> <uri>" },
      );
    }
    throw new CliError("usage", "missing uri", { usage: "pmcp read <app> <uri>" });
  });

  const apps = on("app", "create and manage apps");
  apps
    .command("create <slug>")
    .description("create a tunneled or proxied app")
    .option("--tunneled", "a tunneled app (the default)")
    .option("--proxied <endpoint>", "a proxied app at this endpoint")
    .option("--auth <mode>", "headers | oauth (proxied only)")
    .option("--typescript-aliases <json>", "owner hub-local service/tool names, as a JSON object")
    .action(async (slug: string, opts: { proxied?: string; auth?: string; typescriptAliases?: string }) => {
      // Parsed before the context: a malformed alias object is argv (§10's local-first
      // rule), and the object travels verbatim — identifier syntax and reservation
      // collisions are the hub's atomic refusal, not a second validator here.
      const typescriptAliases =
        opts.typescriptAliases === undefined ? undefined : jsonObject("--typescript-aliases", opts.typescriptAliases);
      const cmd: AppCommand =
        opts.proxied === undefined
          ? { sub: "create", slug, kind: "tunnel", typescriptAliases }
          : { sub: "create", slug, kind: "proxy", endpoint: opts.proxied, auth: opts.auth === "oauth" ? "oauth" : "headers", typescriptAliases };
      pendingExit = (await app(await context(), cmd)) as 0 | 1;
    });
  for (const sub of ["archive", "unarchive", "delete", "disconnect"] as const) {
    apps
      .command(`${sub} <slug>`)
      .description(`${sub} an app`)
      .action(async (slug: string) => {
        pendingExit = (await app(await context(), { sub, slug })) as 0 | 1;
      });
  }
  apps
    .command("set-auth <slug>")
    .description("replace a proxied app's upstream headers")
    .option("--header <header...>", "'Name: value', repeatable")
    .action(async (slug: string, opts: { header?: string[] }) => {
      const headers: Record<string, string> = {};
      for (const header of opts.header ?? []) {
        const colon = header.indexOf(":");
        if (colon === -1) throw new CliError("usage", `--header wants 'Name: value', got ${header}`);
        headers[header.slice(0, colon).trim()] = header.slice(colon + 1).trim();
      }
      pendingExit = (await app(await context(), { sub: "set-auth", slug, headers })) as 0 | 1;
    });
  // The guessable noun-verb form (§10): `pmcp app list` is `pmcp ls`.
  apps
    .command("list")
    .description("alias of `pmcp ls`")
    .action(async () => {
      pendingExit = (await ls(await context())) as 0 | 1;
    });
  // §23.6's owner lane, on the update side: one `app_update` carrying `typescript_aliases`.
  // Omission preserves an established assignment, so this verb exists precisely because
  // create cannot change one — and it never renames the upstream's canonical MCP names.
  apps
    .command("aliases")
    .description("hub-local TypeScript names for an app")
    .command("set <slug> [words...]")
    .description("set an app's owner TypeScript aliases")
    .option("--args <json>", "the aliases object {service?, tools?}, as JSON")
    .action(async (slug: string, words: string[], opts: { args?: string }) => {
      const aliases = payloadArguments(
        opts.args,
        words,
        `pmcp app aliases set <slug> --args '{"service":"news","tools":{"get-news":"getNews"}}'`,
      );
      pendingExit = (await app(await context(), { sub: "set-aliases", slug, typescriptAliases: aliases })) as 0 | 1;
    });

  // ── §23: the hub's own surface ────────────────────────────────────────────────────────
  // `execute`/`search-types` address the virtual hub app's scoped mount; `settings` reads
  // and writes the owner-scoped pair the sandbox deadline is chosen from. Registered here
  // as ONE family because §23.1 makes them one surface: a caller who can run a program is
  // the caller those settings bound.
  const hub = on("hub", "run TypeScript in the hub sandbox, and read or set its execution timeouts");
  hub
    .command("execute [words...]")
    .description("run one TypeScript program against your authorized catalog (scoped /mcp/hub)")
    .option("--args <json>", "the execute arguments object, as JSON")
    .action(async (words: string[], opts: { args?: string }) => {
      const args = payloadArguments(opts.args, words, `pmcp hub execute --args '{"code":"export default 1","timeout_ms":5000}'`);
      pendingExit = (await hubCall(await context(), "execute", args)) as 0 | 1;
    });
  hub
    .command("search-types [words...]")
    .description("search the TypeScript declarations your credential can see")
    .option("--args <json>", "the search arguments object, as JSON")
    .action(async (words: string[], opts: { args?: string }) => {
      const args = payloadArguments(opts.args, words, `pmcp hub search-types --args '{"query":"news"}'`);
      pendingExit = (await hubCall(await context(), "search_types", args)) as 0 | 1;
    });
  const hubSettings = hub.command("settings").description("owner execution settings, in milliseconds");
  hubSettings
    .command("get")
    .description("read the default and maximum execution timeout")
    .action(async () => {
      pendingExit = (await hubSettingsGet(await context())) as 0 | 1;
    });
  hubSettings
    .command("set")
    .description("set the default and maximum execution timeout")
    .option("--default-timeout-ms <int>", "the timeout execute uses when it omits timeout_ms")
    .option("--max-timeout-ms <int>", "the ceiling an execute request may ask for")
    .action(async (opts: { defaultTimeoutMs?: string; maxTimeoutMs?: string }) => {
      // Both flags resolve before the context: an untranslatable pair is malformed argv, and
      // §10's local-first rule forbids reporting it as whatever the hub says about the token
      // — §23.3's bounds are the hub's own predicate, and they are checked identically here.
      const defaultTimeoutMs = timeoutFlagMs("--default-timeout-ms", opts.defaultTimeoutMs);
      const maxTimeoutMs = timeoutFlagMs("--max-timeout-ms", opts.maxTimeoutMs);
      if (defaultTimeoutMs > maxTimeoutMs) {
        throw new CliError("usage", `--default-timeout-ms (${defaultTimeoutMs}) must not exceed --max-timeout-ms (${maxTimeoutMs})`, {
          usage: HUB_SETTINGS_USAGE,
        });
      }
      pendingExit = (await hubSettingsSet(await context(), { defaultTimeoutMs, maxTimeoutMs })) as 0 | 1;
    });
  for (const sub of hub.commands) {
    sub.addHelpText("after", GLOBAL_HELP);
    for (const leaf of sub.commands) leaf.addHelpText("after", GLOBAL_HELP);
  }

  const agents = on("agent", "agents and their grants");
  agents
    .command("list")
    .description("every agent with its grants inline")
    .action(async () => {
      pendingExit = (await agent(await context(), { sub: "list" })) as 0 | 1;
    });
  agents
    .command("create <slug>")
    .description("create an agent")
    .option("--name <name>", "display name")
    .option("--description <text>", "description")
    .action(async (slug: string, opts: { name?: string; description?: string }) => {
      pendingExit = (await agent(await context(), { sub: "create", slug, name: opts.name, description: opts.description })) as 0 | 1;
    });
  agents
    .command("update <slug>")
    .description("update an agent's name/description (slug is immutable)")
    .option("--name <name>", "display name")
    .option("--description <text>", "description")
    .action(async (slug: string, opts: { name?: string; description?: string }) => {
      pendingExit = (await agent(await context(), { sub: "update", slug, name: opts.name, description: opts.description })) as 0 | 1;
    });
  agents
    .command("delete <slug>")
    .description("delete an agent (grants cascade)")
    .action(async (slug: string) => {
      pendingExit = (await agent(await context(), { sub: "delete", slug })) as 0 | 1;
    });

  on("approvals", "pending approval requests, newest first", "pmcp approvals --pending --json")
    .option("--pending", "pending only")
    .option("--history", "decided only")
    .action(async (opts: { pending?: boolean; history?: boolean }) => {
      pendingExit = (await approval(await context(), {
        sub: "list",
        filter: opts.pending === true ? "pending" : opts.history === true ? "history" : undefined,
      })) as 0 | 1;
    });
  for (const decision of ["approve", "reject"] as const) {
    on(`${decision} <id>`, `${decision} one pending request`).action(async (id: string) => {
      pendingExit = (await approval(await context(), { sub: decision, id })) as 0 | 1;
    });
  }
  // `pmcp approval list` → `pmcp approvals` (§10's noun-verb alias).
  on("approval", "alias family: `pmcp approval list` is `pmcp approvals`", undefined, true)
    .command("list")
    .action(async () => {
      pendingExit = (await approval(await context(), { sub: "list" })) as 0 | 1;
    });

  const tokens = on("token", "issue, list and revoke credentials");
  tokens
    .command("issue")
    .description("mint a key for an agent or a tunneled app")
    .option("--agent <slug>", "an agent")
    .option("--app <slug>", "a tunneled app")
    .option("--expires <duration>", "90d | 3600 | never")
    .action(async (opts: { agent?: string; app?: string; expires?: string }) => {
      // Resolved before either branch, so an untranslatable lifetime fails the same way for
      // both kinds — and before anything is minted.
      const expires = expiresIn(opts.expires);
      const cmd: TokenCommand =
        opts.agent !== undefined
          ? { sub: "issue", kind: "agent", slug: opts.agent, expires }
          : opts.app !== undefined
            ? { sub: "issue", kind: "app", slug: opts.app, expires }
            : (() => {
                throw new CliError("usage", "pmcp token issue needs --agent <slug> or --app <slug>", {
                  usage: "pmcp token issue (--agent <slug> | --app <slug>) [--expires 90d]",
                });
              })();
      pendingExit = (await token(await context(), cmd)) as 0 | 1;
    });
  tokens
    .command("list")
    .description("this namespace's credentials, never plaintext")
    .action(async () => {
      pendingExit = (await token(await context(), { sub: "list" })) as 0 | 1;
    });
  tokens
    .command("revoke <id>")
    .description("revoke one credential, immediately")
    .action(async (id: string) => {
      pendingExit = (await token(await context(), { sub: "revoke", id })) as 0 | 1;
    });

  const adminTokens = on("admin-token", "issue, list and revoke pmcp_adm_ hub-admin tokens");
  adminTokens
    .command("issue")
    .description("mint a hub-admin credential from a signed-in session")
    .option("--expires <duration>", "365d | 3600 | never")
    .action(async (opts: { expires?: string }) => {
      // Resolved before the context, matching `token issue` (§10): an untranslatable
      // lifetime fails the same way — before any credential resolution or request.
      const expires = expiresIn(opts.expires);
      pendingExit = (await adminToken(await context(), { sub: "issue", expires })) as 0 | 1;
    });
  adminTokens
    .command("list")
    .description("this namespace's admin tokens, never plaintext")
    .action(async () => {
      pendingExit = (await adminToken(await context(), { sub: "list" })) as 0 | 1;
    });
  adminTokens
    .command("revoke <id>")
    .description("revoke one admin token, immediately")
    .action(async (id: string) => {
      pendingExit = (await adminToken(await context(), { sub: "revoke", id })) as 0 | 1;
    });

  on("audit", "the namespace's event history", "pmcp audit --app mcp-tools --since 7d")
    .option("--agent <slug>", "narrow to one agent")
    .option("--app <slug>", "narrow to one app")
    .option("--event <name>", "exact event name")
    .option("--tool <name>", "exact unprefixed tool name")
    .option("--session <id>", "exact client session id")
    .option("--since <when>", "7d | ISO-8601 | epoch ms")
    .option("--until <when>", "7d | ISO-8601 | epoch ms")
    .option("--limit <count>", "page size")
    .option("--export <format>", "jsonl streams every matching row")
    .action(async (opts: Record<string, string | undefined>) => {
      // The two translated flags resolve BEFORE the context: `await context()` is a network
      // whoami, and an unparseable `--since` resolved after it would be reported as a hub
      // failure rather than the malformed argv it is (§10).
      const filters: AuditFilters = {
        agent: opts.agent,
        app: opts.app,
        event: opts.event,
        tool: opts.tool,
        session: opts.session,
        since: instantMs("since", opts.since),
        until: instantMs("until", opts.until),
        limit: opts.limit === undefined ? undefined : Number(opts.limit),
      };
      pendingExit = (await audit(await context(), filters, { exportJsonl: opts.export === "jsonl" })) as 0 | 1;
    });

  on("connect <app>", "print a proxied app's OAuth connect URL", "pmcp connect linear").action(async (slug: string) => {
    pendingExit = (await connect(await context(), slug)) as 0 | 1;
  });
  on("connections", "the OAuth clients connected to this namespace").action(async () => {
    pendingExit = (await connection(await context(), { sub: "list" })) as 0 | 1;
  });
  const connections = on("connection", "inbound OAuth client connections");
  connections
    .command("revoke <id>")
    .description("revoke one connection, immediately")
    .action(async (id: string) => {
      pendingExit = (await connection(await context(), { sub: "revoke", id })) as 0 | 1;
    });
  connections
    .command("list")
    .description("alias of `pmcp connections`")
    .action(async () => {
      pendingExit = (await connection(await context(), { sub: "list" })) as 0 | 1;
    });


  return program;
}

function requireWord(value: string | undefined, what: string, usage: string): string {
  if (value === undefined || value === "") throw new CliError("usage", `missing ${what}`, { usage });
  return value;
}

/**
 * The CLI's one duration grammar — `<count><unit>` over seconds, minutes, hours, days
 * (§10 spells `--since 7d` and `--expires 90d` with it) — as a span in milliseconds, or
 * undefined for a value that is not one. Deliberately unopinionated about the miss: the
 * two flags below differ in what ELSE they accept and in what unit they must end up, and
 * only they know that.
 */
const DURATION = /^(\d+)([smhd])$/;
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

function durationMs(value: string): number | undefined {
  // deps: none
  const match = DURATION.exec(value);
  return match === null ? undefined : Number(match[1]) * DURATION_UNIT_MS[match[2] as keyof typeof DURATION_UNIT_MS];
}

/**
 * `--since` / `--until` → the epoch-MS integer audit_query declares (§8). Resolved HERE
 * and not forwarded, because the hub's field is an integer and it has no duration grammar
 * to resolve one with: a duration is that long AGO, an all-digits value is the epoch it
 * already spells, and anything else is read as an ISO-8601 instant. A value that is none
 * of the three is malformed argv naming the flag — a frame the hub would answer with
 * `invalid params` is one this CLI must never put on the wire.
 */
function instantMs(flag: "since" | "until", value: string | undefined): number | undefined {
  // deps: none
  if (value === undefined) return undefined;
  const ago = durationMs(value);
  if (ago !== undefined) return Date.now() - ago;
  if (/^\d+$/.test(value)) return Number(value);
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) {
    throw new CliError("usage", `--${flag} wants a duration ago (7d, 12h, 30m, 45s), an ISO-8601 instant, or epoch ms — got "${value}"`);
  }
  return instant;
}

/**
 * `--expires` → the SECONDS-of-lifetime integer token_issue declares, or the literal
 * `never` (§8). A duration here is a LIFETIME from now rather than an instant, and the
 * unit is seconds where audit's is milliseconds — which is exactly why the two flags
 * share the grammar above and nothing else. An all-digits value is the second count it
 * already spells; anything else is the same local refusal, raised before a key is minted.
 */
function expiresIn(value: string | undefined): number | "never" | undefined {
  // deps: none
  if (value === undefined || value === "never") return value;
  const lifetime = durationMs(value);
  if (lifetime !== undefined) return lifetime / 1_000;
  if (/^\d+$/.test(value)) return Number(value);
  throw new CliError("usage", `--expires wants a duration (90d, 12h, 30m, 45s), a count of seconds, or "never" — got "${value}"`);
}

/**
 * One `--args`/`--typescript-aliases` value as the JSON OBJECT it has to be. Shared by
 * `toolArguments`' `--args` branch and the whole-payload parsers (the two hub tools, the
 * alias verbs, `--typescript-aliases`) so none of them can drift on what "valid JSON"
 * means; a value that parses but is not an object (an array, a bare string, a number) is
 * malformed argv — every schema these reach declares an object, and a cast would put the
 * wrong JSON type on the wire under the right flag.
 */
function jsonObject(flag: string, json: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new CliError("usage", `${flag} is not valid JSON (${error instanceof Error ? error.message : String(error)})`, {
      hints: [`quote the keys: ${flag} '{"…":"…"}'`],
    });
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError("usage", `${flag} must be one JSON object`, { hints: [`quote the keys: ${flag} '{"…":"…"}'`] });
  }
  return parsed as Record<string, unknown>;
}

/**
 * The whole-payload spelling of `--args`, spoken by `hub execute`, `hub search-types` and
 * `app aliases set`: ALL input is one JSON object, because the schemas behind these carry a
 * JSON integer and/or a nested object (`timeout_ms`, `tools`) that `key=value` cannot
 * express without a coercion — and §10 forbids passing a numeric `key=value` string as a
 * schema integer. A positional word is therefore refused rather than parsed, and a missing
 * payload is malformed argv: both before `await context()` and before any request (§10's
 * local-first rule).
 */
function payloadArguments(argsJson: string | undefined, words: readonly string[], usage: string): Record<string, unknown> {
  if (words.length > 0) {
    throw new CliError("usage", `"${words[0]}" is not a separate argument — this payload is one JSON object`, {
      usage,
      hints: ["pass the payload as --args '{…}'"],
    });
  }
  if (argsJson === undefined) throw new CliError("usage", "missing --args", { usage });
  return jsonObject("--args", argsJson);
}

/**
 * One settings flag as §23.3's bounded integer: a plain decimal count of milliseconds
 * between 1_000 and 300_000. `Number` is only ever called on a pure digit run, so `30s`,
 * `3e4`, `0x1d4c` and any `key=value` residue fail as the malformed argv they are — never
 * a silent `NaN`, and never an integer coerced out of a string the operator did not type
 * as one.
 */
function timeoutFlagMs(flag: string, value: string | undefined): number {
  if (value === undefined) throw new CliError("usage", `missing ${flag}`, { usage: HUB_SETTINGS_USAGE });
  if (!/^\d+$/.test(value)) {
    throw new CliError("usage", `${flag} wants a whole number of milliseconds, got "${value}"`, { usage: HUB_SETTINGS_USAGE });
  }
  const ms = Number(value);
  if (ms < HUB_TIMEOUT_MIN_MS || ms > HUB_TIMEOUT_MAX_MS) {
    throw new CliError("usage", `${flag} must be between ${HUB_TIMEOUT_MIN_MS} and ${HUB_TIMEOUT_MAX_MS} ms, got ${ms}`, {
      usage: HUB_SETTINGS_USAGE,
    });
  }
  return ms;
}

/**
 * `--args '{…}'`, or repeated `key=value` words, into one arguments object. `--args` is the
 * payload flag §10 renamed it to: `--json` now means output format on every command, and
 * the two could not both be spelled `--json`.
 */
function toolArguments(words: string[], argsJson: string | undefined): Record<string, unknown> {
  // Both spellings at once would make one of them silently lose — the executed call would
  // differ from the one typed, which is worse than refusing.
  if (argsJson !== undefined && words.length > 0) {
    throw new CliError("usage", "--args and key=value are two spellings of the same arguments object — pick one");
  }
  if (argsJson !== undefined) return jsonObject("--args", argsJson);
  const args: Record<string, unknown> = {};
  for (const word of words) {
    const equals = word.indexOf("=");
    // The caller partitions by shape, so this is a guard rather than a filter: a word the
    // user typed and this function dropped would be a silently empty argument object.
    if (equals === -1) throw new CliError("usage", `expected key=value, got ${word}`);
    args[word.slice(0, equals)] = word.slice(equals + 1);
  }
  return args;
}

/**
 * One y/N prompt on stdin; anything but y/yes is a refusal, as is having nobody to ask.
 * A non-interactive stdin refuses immediately on stderr instead of waiting for input that
 * cannot arrive.
 */
function confirm(question: string): Promise<boolean> {
  if (process.stdin.isTTY !== true) {
    emitError(
      new CliError("confirmation_required", question, { hints: ["pass --yes to confirm without a terminal"] }),
      { json: globals.json, stream: process.stderr },
    );
    return Promise.resolve(false);
  }
  // Prompts use stderr so stdout remains exclusively the command's result stream.
  process.stderr.write(`${question} [y/N] `);
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

/** Kept exported for the `pnpm users` bridge — the precedence lives in config.ts now. */
export { applyProfile } from "./config.ts";
