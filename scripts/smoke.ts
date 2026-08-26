// smoke.ts — the live end-to-end walk against a DEPLOYED hub. One process, one throwaway
// namespace, every layer the design has: §12's bootstrap route, §4's password sign-in,
// §14's CLI device flow and the `pmcp` commands it authenticates, §8's whoami and admin
// ops over the `pmcp` MCP surface, §7's handshake and dispatch,
// §6's reverse tunnel (served from this very process by the REAL client library,
// clients/js/src/index.ts), §7's approval gate, §15's ledger — and then the teardown,
// verified.
//
// The tunnel leg used to run on scripts/thin-serve.ts, D7's verified slice of the transport.
// That file is deleted: the library now owns everything it proved (the derived address, the
// register ceremony, the control-frame split, the close-code table) plus what it could not
// do (the 401-vs-403 upgrade split), so keeping a second implementation of the same wire
// alive only to smoke-test the first one was the fork its own header called a known ceiling.
// What this walk still holds itself is the MCP half — answering tools/list and one
// tools/call — because it carries no MCP SDK; the library's job starts at the socket.
//
//   HUB_ORIGIN=https://… BOOTSTRAP_SECRET=… node --experimental-strip-types scripts/smoke.ts
//
// It is a WALK, not a test suite: every step prints what was observed, the first failure
// stops the walk, cleanup runs regardless, and the exit code is the verdict. Nothing here
// re-asserts what the vitest suites already own — a suite failing is a bug in the hub, this
// script failing is a bug in the DEPLOYMENT (a missing secret, an unmigrated database, a
// DO binding that did not ship). That is the only reason it exists, and the reason every
// step talks to a real origin over real HTTP and a real WebSocket.
//
// Re-runnable by construction: the namespace is `smoke-<epoch>`, and step 0 deletes every
// leftover `smoke-*` user before creating a new one — a walk killed halfway leaves nothing
// that breaks the next run.
//
// SECRETS: the bootstrap secret, the generated passwords, and both minted tokens exist in
// variables and NEVER in output (§15). What gets printed about a credential is its kind and
// whether it worked. D8 is the completing owner.
//
// ponytail: no argv, no flags, no dry-run mode. Two env vars and a fixed walk — a knob
// nobody has asked for is a knob that goes stale. Add one when a second caller appears.

import { main as cli } from "../cli/src/main.ts";
import { caller, HubTransport } from "../clients/js/src/index.ts";

// ── the walk ──────────────────────────────────────────────────────────────────────────

const ORIGIN = required("HUB_ORIGIN").replace(/\/+$/, "");
const SECRET = required("BOOTSTRAP_SECRET");
const USERNAME = `smoke-${Date.now()}`;
const ACCOUNT = "smoke-agent";
const SERVICE = "smoke-svc";
const ROLE = "reader";
const TOOL = "echo";
/** The RFC 8628 client id cli/src/main.ts presents — the same string, on purpose. */
const DEVICE_CLIENT_ID = "pmcp-cli";
/** The one call the walk makes through the tunnel. Reused verbatim on the approval retry —
 *  §7 binds an approval to the canonical JSON of `arguments`, so the retry must be
 *  byte-identical to match the row. */
const CALL_ARGS = { text: "smoke" } as const;

async function main(): Promise<number> {
  let password = "";
  let session = "";
  let cliSession = "";
  let agentToken = "";
  let serviceToken = "";
  let approvalId = "";
  let tunnel: { close(): Promise<void> } | null = null;
  // What cleanup has to undo. A walk that stopped before creating something must not report
  // a failed cleanup for it — the exit code is the verdict, and noise in it is a lie.
  let userExists = false;
  let serviceExists = false;

  const owner = (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
    adminOp(session, name, args);

  try {
    await step("bootstrap idempotent cleanup", async () => {
      const listed = await bootstrap({ op: "list" });
      // `smoke-<epoch>` exactly — this script's own naming and nothing else. A real
      // namespace called `smoke-tests` is not a leftover, and deletion is terminal.
      const leftovers = asStrings(listed.usernames).filter((name) => /^smoke-\d+$/.test(name));
      for (const name of leftovers) await bootstrap({ op: "delete", username: name });
      return leftovers.length === 0 ? "no leftover smoke-* users" : `deleted ${leftovers.join(", ")}`;
    });

    await step("bootstrap create user", async () => {
      const created = await bootstrap({ op: "create", username: USERNAME });
      if (created.username !== USERNAME) throw new Error(`created ${String(created.username)}`);
      userExists = true;
      return `${USERNAME} created (password withheld)`;
    });

    await step("bootstrap set password", async () => {
      const reset = await bootstrap({ op: "reset-password", username: USERNAME });
      password = asString(reset.password, "password");
      return `password set for ${USERNAME} (${password.length} chars, withheld)`;
    });

    await step("sign in", async () => {
      session = await signIn(USERNAME, password);
      return `session bearer issued (${session.length} chars, withheld)`;
    });

    await step("whoami", async () => {
      const me = await getJson(`${ORIGIN}/api/whoami`, session);
      expect(me.principal === `user:${USERNAME}`, `principal ${String(me.principal)}`);
      expect(me.namespace === USERNAME, `namespace ${String(me.namespace)}`);
      return `${String(me.principal)} in namespace ${String(me.namespace)}`;
    });

    await step("CLI device flow (§14) approved with the web session", async () => {
      // The /device PAGE is a later dispatch; the flow underneath it is better-auth's own
      // endpoints, and that is what the CLI speaks. GET /api/auth/device claims the code
      // for the signed-in user (approve refuses an unclaimed one), and the approval POST
      // is the browser's half, driven here with the smoke session.
      const requested = await postJson(`${ORIGIN}/api/auth/device/code`, { client_id: DEVICE_CLIENT_ID });
      const userCode = asString(requested.user_code, "user_code");
      const deviceCode = asString(requested.device_code, "device_code");
      await getJson(`${ORIGIN}/api/auth/device?user_code=${encodeURIComponent(userCode)}`, session);
      const approved = await postJson(`${ORIGIN}/api/auth/device/approve`, { userCode }, session);
      expect(approved.success === true, `approve answered ${JSON.stringify(approved)}`);
      const granted = await postJson(`${ORIGIN}/api/auth/device/token`, {
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: DEVICE_CLIENT_ID,
      });
      cliSession = asString(granted.access_token, "access_token");
      return `user code approved, session bearer issued (${cliSession.length} chars, withheld)`;
    });

    await step("pmcp whoami + ls through the CLI itself", async () => {
      // The real command table, over the device-flow session: PMCP_TOKEN overrides the
      // stored config (§10), so the walk never touches ~/.config/pmcp.
      process.env.PMCP_URL = ORIGIN;
      process.env.PMCP_TOKEN = cliSession;
      const whoami = await cli(["whoami"]);
      const listed = await cli(["ls"]);
      expect(whoami === 0, `pmcp whoami exited ${whoami}`);
      expect(listed === 0, `pmcp ls exited ${listed}`);
      return "pmcp whoami and pmcp ls both exited 0";
    });

    await step("pmcp account_create", async () => {
      const created = await owner("account_create", { slug: ACCOUNT });
      const account = asRecord(created.account, "account");
      return `service account ${String(account.slug)}`;
    });

    await step("pmcp token_issue (pmcp_sa_)", async () => {
      const minted = await owner("token_issue", { kind: "service_account", slug: ACCOUNT });
      agentToken = asString(minted.token, "token");
      expect(agentToken.startsWith("pmcp_sa_"), "minted key is not a pmcp_sa_ token");
      return `pmcp_sa_ key ${String(minted.id)} (value withheld)`;
    });

    await step("MCP handshake as the service account", async () => {
      const init = asRecord(await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "initialize", {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "pmcp-smoke", version: "0" },
      }), "initialize result");
      expect(init.protocolVersion === "2026-07-28", `protocolVersion ${String(init.protocolVersion)}`);
      const notified = await notify(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "notifications/initialized");
      expect(notified === 202, `notifications/initialized answered ${notified}`);
      const discovered = asRecord(
        await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "server/discover"),
        "server/discover result",
      );
      const listed = asRecord(await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "tools/list"), "tools/list result");
      const serverInfo = asRecord(init.serverInfo, "serverInfo");
      return `initialize ${String(serverInfo.name)}, notifications/initialized 202, discover ${JSON.stringify(discovered.supportedVersions)}, tools/list ${asArray(listed.tools).length} tools`;
    });

    await step("pmcp service_create (tunnel)", async () => {
      const created = await owner("service_create", { slug: SERVICE, kind: "tunnel" });
      const service = asRecord(created.service, "service");
      expect(service.kind === "tunnel", `kind ${String(service.kind)}`);
      serviceExists = true;
      return `${String(service.slug)} (${String(service.kind)}, status ${String(service.status)})`;
    });

    await step("pmcp token_issue (pmcp_svc_)", async () => {
      const minted = await owner("token_issue", { kind: "service", slug: SERVICE });
      serviceToken = asString(minted.token, "token");
      expect(serviceToken.startsWith("pmcp_svc_"), "minted key is not a pmcp_svc_ token");
      return `pmcp_svc_ key ${String(minted.id)} (value withheld)`;
    });

    await step("client library connects and registers", async () => {
      const service = serveOneTool(serviceToken, {
        name: TOOL,
        description: "Echoes its argument back, with the caller the hub asserted.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        // The caller is the point: what comes back proves §7's identity forwarding
        // survived the whole path, not just that the socket carried bytes.
        run: (args, who) => ({ echo: args.text, principal: who.principal, roles: who.roles }),
      });
      tunnel = service;
      await deadline(service.registered, 20_000, "hub/register was never accepted");
      return `registered role ${ROLE} declaring tool ${TOOL} through @personal-mcps/client`;
    });

    await step("service reports online", async () => {
      const status = await until(
        async () => asRecord((await owner("service_get", { slug: SERVICE })).service, "service").status,
        (value) => value === "online",
        15_000,
      );
      return `service_get status ${String(status)}`;
    });

    await step("pmcp grant_set", async () => {
      const granted = await owner("grant_set", { account: ACCOUNT, service: SERVICE, roles: [ROLE] });
      const warnings = asArray(granted.warnings);
      return `${ACCOUNT} → ${SERVICE}: [${ROLE}]${warnings.length === 0 ? "" : ` warnings ${JSON.stringify(warnings)}`}`;
    });

    await step("tools/list through the tunnel", async () => {
      const names = await until(
        async () => {
          const listed = asRecord(
            await mcp(`${ORIGIN}/${USERNAME}/mcp/${SERVICE}`, agentToken, "tools/list"),
            "tools/list result",
          );
          return asArray(listed.tools).map((tool) => String(asRecord(tool, "catalog entry").name));
        },
        (found) => found.includes(TOOL),
        15_000,
      );
      return `scoped catalog ${JSON.stringify(names)}`;
    });

    await step("tools/call through the tunnel", async () => {
      const result = asRecord(await callTool(agentToken), "tools/call result");
      const structured = asRecord(result.structuredContent, "structuredContent");
      expect(structured.echo === CALL_ARGS.text, `echo ${String(structured.echo)}`);
      expect(structured.principal === `sa:${ACCOUNT}`, `principal ${String(structured.principal)}`);
      return `echo "${String(structured.echo)}" from ${String(structured.principal)} roles ${JSON.stringify(structured.roles)}`;
    });

    await step("approval mode refuses the call (-32003)", async () => {
      await owner("grant_set", { account: ACCOUNT, service: SERVICE, roles: [`${ROLE}:approval`] });
      const refusal = await expectError(callTool(agentToken));
      expect(refusal.code === -32003, `code ${String(refusal.code)}`);
      approvalId = asString(asRecord(refusal.data, "-32003 data").approvalId, "approvalId");
      return `-32003 approval ${approvalId}`;
    });

    await step("pmcp approval_decide approve", async () => {
      const decided = await owner("approval_decide", { id: approvalId, decision: "approve" });
      expect(decided.decision === "approve", `decision ${String(decided.decision)}`);
      return `approved ${String(decided.id)}`;
    });

    await step("approved retry executes", async () => {
      const result = asRecord(await callTool(agentToken), "tools/call result");
      const structured = asRecord(result.structuredContent, "structuredContent");
      expect(structured.echo === CALL_ARGS.text, `echo ${String(structured.echo)}`);
      return `identical retry executed, echo "${String(structured.echo)}"`;
    });

    await step("audit_query sees the calls", async () => {
      const rows = asArray((await owner("audit_query", { service: SERVICE })).rows);
      const calls = rows.filter((row) => asRecord(row, "audit row").event === "tools/call");
      expect(calls.length >= 2, `only ${calls.length} tools/call rows`);
      const events = rows.map((row) => String(asRecord(row, "audit row").event));
      return `${rows.length} rows for ${SERVICE}, ${calls.length} tools/call — ${JSON.stringify(unique(events))}`;
    });
  } catch {
    // The step that failed already printed why; the walk stops and cleanup still runs.
  }

  // ── cleanup, always, and verified ──────────────────────────────────────────────────
  await settle(
    step("cleanup: close the tunnel client", async () => {
      await tunnel?.close();
      return tunnel === null ? "no client to close" : "socket closed";
    }),
  );

  await settle(
    step("cleanup: delete the service", async () => {
      if (!serviceExists) return "no service to delete";
      await owner("service_delete", { slug: SERVICE });
      const slugs = asArray((await owner("service_list")).services).map((row) =>
        String(asRecord(row, "service_list row").slug),
      );
      expect(!slugs.includes(SERVICE), `service_list still lists ${SERVICE}`);
      return `${SERVICE} gone; service_list ${JSON.stringify(slugs)}`;
    }),
  );

  await settle(
    step("cleanup: delete the user", async () => {
      if (!userExists) return "no user to delete";
      await bootstrap({ op: "delete", username: USERNAME });
      const listed = await bootstrap({ op: "list" });
      expect(!asStrings(listed.usernames).includes(USERNAME), `${USERNAME} still listed`);
      const probe = await fetch(`${ORIGIN}/api/whoami`, { headers: { Authorization: `Bearer ${session}` } });
      expect(probe.status === 401, `whoami with the dead session answered ${probe.status}`);
      return `${USERNAME} gone; its session now 401`;
    }),
  );

  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log(
    failed.length === 0
      ? `SMOKE PASS — ${results.length} steps against ${ORIGIN}`
      : `SMOKE FAIL — ${failed.length}/${results.length} steps failed: ${failed.map((r) => r.name).join(", ")}`,
  );
  return failed.length === 0 ? 0 : 1;
}

// ── step reporting ────────────────────────────────────────────────────────────────────

const results: { name: string; ok: boolean }[] = [];

/** One step: prints its own verdict and the observation behind it, and rethrows so the
 *  walk stops at the first failure (cleanup steps are wrapped in {@link settle}). */
async function step(name: string, work: () => Promise<string>): Promise<void> {
  try {
    const observed = await work();
    results.push({ name, ok: true });
    console.log(`[ ok ] ${name} — ${observed}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`[FAIL] ${name} — ${messageOf(err)}`);
    throw err;
  }
}

/** A step whose failure must not stop the ones after it — every cleanup step. */
function settle(promise: Promise<void>): Promise<void> {
  return promise.catch(() => {});
}

/** An in-step assertion: the message is what the step prints when it fails. */
function expect(condition: boolean, observed: string): void {
  if (!condition) throw new Error(observed);
}

// ── the three wires ───────────────────────────────────────────────────────────────────

/** §12's bootstrap route: the secret rides `Authorization: Bearer`, never the body or URL.
 *  404 means the route is disabled (BOOTSTRAP_SECRET unset on the Worker), not "not found". */
async function bootstrap(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(`${ORIGIN}/internal/users`, {
    method: "POST",
    headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (response.status === 404) throw new Error("bootstrap route is disabled (BOOTSTRAP_SECRET unset on the Worker)");
  if (response.status === 401) throw new Error("bootstrap secret rejected");
  if (!response.ok) throw new Error(`bootstrap ${String(body.op)} → ${response.status} ${await response.text()}`);
  return asRecord(await response.json(), `bootstrap ${String(body.op)} response`);
}

/** §4's password sign-in. better-auth's bearer plugin answers with the session token in the
 *  `set-auth-token` header; the body carries it too, and either is the bearer from here on. */
async function signIn(username: string, password: string): Promise<string> {
  const response = await fetch(`${ORIGIN}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`sign-in → ${response.status} ${await response.text()}`);
  const body = asRecord(await response.json(), "sign-in response");
  const token = response.headers.get("set-auth-token") ?? body.token;
  if (typeof token !== "string" || token === "") throw new Error("sign-in carried no session token");
  return token;
}

/** One JSON POST, optionally as a signed-in user — the device-flow leg's whole transport. */
async function postJson(url: string, body: unknown, bearer?: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = asRecord(parsed, `POST ${url} body`);
    throw new Error(`POST ${url} → ${response.status} ${String(detail.error_description ?? detail.error ?? "")}`);
  }
  return asRecord(parsed, `POST ${url} response`);
}

async function getJson(url: string, bearer: string): Promise<Record<string, unknown>> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${bearer}` } });
  if (!response.ok) throw new Error(`GET ${url} → ${response.status}`);
  return asRecord(await response.json(), `GET ${url} response`);
}

/** One JSON-RPC request against an MCP endpoint. §7 answers 200 whether or not it refused,
 *  so a JSON-RPC `error` becomes a thrown {@link RpcError} here and an HTTP status never is. */
async function mcp(endpoint: string, bearer: string, method: string, params?: unknown): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  if (!response.ok) throw new Error(`${method} ${endpoint} → HTTP ${response.status} ${await response.text()}`);
  const body = asRecord(await response.json(), `${method} response`);
  if (body.error !== undefined) throw new RpcError(asRecord(body.error, `${method} error`));
  return body.result;
}

/** A notification — no id, so §7 absorbs it with a bodyless 202. The status IS the answer. */
async function notify(endpoint: string, bearer: string, method: string): Promise<number> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  });
  return response.status;
}

/** One §8 admin op through the builtin `pmcp` service, as the owner. */
async function adminOp(session: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = asRecord(
    await mcp(`${ORIGIN}/${USERNAME}/mcp/pmcp`, session, "tools/call", { name, arguments: args }),
    `${name} result`,
  );
  return asRecord(result.structuredContent, `${name} structuredContent`);
}

/** The walk's one tunneled call, spelled once so the approval retry is byte-identical. */
async function callTool(bearer: string): Promise<unknown> {
  return mcp(`${ORIGIN}/${USERNAME}/mcp/${SERVICE}`, bearer, "tools/call", {
    name: TOOL,
    arguments: CALL_ARGS,
  });
}

// ── the one tunneled service, served through the real client library ──────────────────

/** The one tool this walk serves. `run` returns the STRUCTURED value; both carriers of the
 *  2026-07-28 result (text and structuredContent) are built from it. */
type SmokeTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, who: { principal: string; roles: readonly string[] }): unknown;
};

/**
 * Run one tool as a tunneled service on `@personal-mcps/client`'s transport. The library
 * owns everything below the frame — dial, `hub/register`, reconnects, close codes, pings;
 * this function is only the MCP session the walk has no SDK for, which is exactly the
 * split §11 draws (`serve(server, …)` is this, with a real SDK server in place of these
 * twenty lines). HubTransport rather than serve() because the walk needs a shutdown
 * handle: serve()'s promise is the bot's main loop and hands back nothing to close.
 */
function serveOneTool(token: string, tool: SmokeTool): { registered: Promise<void>; close(): Promise<void> } {
  const transport = new HubTransport({ url: ORIGIN, token, roles: { [ROLE]: [tool.name] } });
  transport.onmessage = (message) => {
    const frame = message as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof frame.method !== "string" || frame.id === undefined) return; // a notification
    void transport.send(answer(frame, tool));
  };
  return { registered: transport.start(), close: () => transport.close() };
}

/** One hub-originated request answered — the whole MCP surface of this walk. */
function answer(frame: { id?: unknown; method?: unknown; params?: unknown }, tool: SmokeTool): Record<string, unknown> {
  const id = frame.id;
  if (frame.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: [{ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }] },
    };
  }
  const params = asRecord(frame.params, "params");
  if (frame.method !== "tools/call" || params.name !== tool.name) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  try {
    // `caller()` is the library's own reader of the hub's `_meta` assertion (§7) — the
    // affordance a service author would use, exercised here on the live wire.
    const value = tool.run(asRecord(params.arguments, "arguments"), caller(asRecord(params._meta, "_meta")));
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value },
    };
  } catch (err) {
    // A tool that threw is a TOOL error, not a protocol one.
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: messageOf(err) }], isError: true } };
  }
}

/** A JSON-RPC refusal, carrying §7's code and `data` (the approval fields on -32003). */
class RpcError extends Error {
  code: unknown;
  data: unknown;
  constructor(error: Record<string, unknown>) {
    super(`${String(error.code)} ${String(error.message)}`);
    this.code = error.code;
    this.data = error.data;
  }
}

/** A step that EXPECTS a refusal: the success case is the failure here. */
async function expectError(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof RpcError) return err;
    throw err;
  }
  throw new Error("the call was expected to be refused and was not");
}

// ── small waits ───────────────────────────────────────────────────────────────────────

/** Polls `read` until `done` accepts its answer, or gives up — every wait in this walk is
 *  on an observation with a bound, never a blind sleep. */
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, budgetMs: number): Promise<T> {
  const stopAt = Date.now() + budgetMs;
  let last = await read();
  while (!done(last)) {
    if (Date.now() > stopAt) throw new Error(`gave up after ${budgetMs} ms; last saw ${JSON.stringify(last)}`);
    await sleep(500);
    last = await read();
  }
  return last;
}

function deadline<T>(promise: Promise<T>, budgetMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    sleep(budgetMs).then(() => {
      throw new Error(`${message} (within ${budgetMs} ms)`);
    }),
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── reading untyped JSON ──────────────────────────────────────────────────────────────

/** A required env var, read at module load — a missing one is an operator mistake with a
 *  one-line answer, not a stack trace. */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.log(`SMOKE FAIL — ${name} is required (HUB_ORIGIN=https://… BOOTSTRAP_SECRET=… node --experimental-strip-types scripts/smoke.ts)`);
    process.exit(1);
  }
  return value;
}

/** The object a step expects, or the step's failure. Answering `{}` for a missing one would
 *  let every step that only PRINTS fields off a record go green against a hub that returned
 *  nothing — and the exit code is this script's whole verdict, so it throws like
 *  {@link asString} and names what was missing. */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`no ${what} in the response`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStrings(value: unknown): string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === "string");
}

function asString(value: unknown, what: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`no ${what} in the response`);
  return value;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.log(`SMOKE FAIL — ${messageOf(err)}`);
    process.exit(1);
  },
);
