// smoke.ts — the live end-to-end walk against a DEPLOYED hub. One process, one throwaway
// namespace, every layer the design has: §12's bootstrap route, §4's password sign-in,
// §14's CLI device flow and the `pmcp` commands it authenticates, §8's whoami and admin
// ops over the `pmcp` surface, §23's aggregate hub surface, §7's scoped dispatch,
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
//   pnpm smoke [--profile <name>]   — url + bootstrap secret resolve from the §10 config
//   profile, and flat HUB_ORIGIN / PMCP_URL / BOOTSTRAP_SECRET env vars override it
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

import { createHash, createHmac, randomBytes } from "node:crypto";
import { applyProfile, main as cli } from "../cli/src/main.ts";
import { caller, HubTransport } from "../clients/js/src/index.ts";

// ── the walk ──────────────────────────────────────────────────────────────────────────

applyProfile(process.argv.slice(2)); // fills PMCP_URL / BOOTSTRAP_SECRET where the env hasn't spoken
const ORIGIN = ((process.env.HUB_ORIGIN ?? "") !== "" ? required("HUB_ORIGIN") : required("PMCP_URL")).replace(/\/+$/, "");
const SECRET = required("BOOTSTRAP_SECRET");
const USERNAME = `smoke-${Date.now()}`;
const AGENT = "smoke-agent";
const APP = "smoke-app";
const ROLE = "reader";
const TOOL = "echo";
/** The RFC 8628 client id cli/src/main.ts presents — the same string, on purpose. */
const DEVICE_CLIENT_ID = "pmcp-cli";
/** §19's throwaway OAuth client's one redirect URI — never actually dereferenced (the walk
 *  reads the code off the Location header with `redirect: "manual"`), so it only has to be a
 *  well-formed, non-loopback https URL, which is what a "web" DCR client's redirect must be
 *  (§19.3). `.invalid` is RFC 2606's reserved never-resolves TLD. */
const OAUTH_REDIRECT_URI = "https://smoke.invalid/callback";
/** The agent §19's OAuth binding is made to — its OWN, separate from `AGENT`,
 *  so the scoped call below is never coupled to the approval-mode grant the main flow
 *  leaves on `AGENT` by the time this step runs. */
const OAUTH_AGENT = "smoke-oauth-agent";
/** The one call the walk makes through the tunnel. Reused verbatim on the approval retry —
 *  §7 binds an approval to the canonical JSON of `arguments`, so the retry must be
 *  byte-identical to match the row. */
const CALL_ARGS = { text: "smoke" } as const;
/**
 * The one tool this walk serves, spelled once. §21's listen leg re-registers the app
 * with this same tool under a CHANGED description, so a shared spelling is what makes the
 * description the single difference between the two registrations — and therefore what
 * makes the doorbell it rings attributable to the change rather than to the reconnect.
 */
const ECHO_TOOL: SmokeTool = {
  name: TOOL,
  description: "Echoes its argument back, with the caller the hub asserted.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  outputSchema: {
    type: "object",
    properties: {
      echo: { type: "string" },
      principal: { type: "string" },
      roles: { type: "array", items: { type: "string" } },
    },
    required: ["echo", "principal", "roles"],
    additionalProperties: false,
  },
  // The caller is the point: what comes back proves §7's identity forwarding survived the
  // whole path, not just that the socket carried bytes.
  run: (args, who) => ({ echo: args.text, principal: who.principal, roles: who.roles }),
};
/** The `Mcp-Session-Id` the listen leg SENDS, so the id the hub answers with can be checked
 *  against it: §21.1 mints its own on every stream and echoes a client's never. */
const CLIENT_SUPPLIED_SESSION = "smoke-supplied-session-never-echoed";
/** §21.1's minted id is UUID-shaped — the hub's own randomUUID, not a value it was handed. */
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a better-auth redirect points, read from EITHER a real 302's `Location` OR the
 * `{ redirect: true, url }` JSON envelope it returns instead when the request looks like a
 * programmatic fetch. §19's `/oauth2/authorize` gates on `handleRedirect`, which 302s only a
 * genuine browser NAVIGATION (`Sec-Fetch-Mode: navigate`) and hands every other caller the
 * envelope — and node's `fetch` cannot send `navigate` (undici forces `Sec-Fetch-Mode: cors`),
 * so this walk always gets the envelope where a browser would get the 302. The DESTINATION is
 * identical either way (`/login?<signed>`, then `/oauth/consent`, then the client's redirect
 * with the code); only the transport status differs, and no deployment can change that. Reads
 * the body via `clone()` so the caller can still consume it. */
async function redirectTarget(res: Response): Promise<string> {
  const location = res.headers.get("location");
  if (location != null && location !== "") return location;
  if (res.status === 200) {
    const body = (await res
      .clone()
      .json()
      .catch(() => null)) as { redirect?: boolean; url?: string } | null;
    if (body?.redirect === true && typeof body.url === "string") return body.url;
  }
  return "";
}

async function main(): Promise<number> {
  let password = "";
  let session = "";
  /** The same session as `session`, in the carrier the §13 pages accept: a signed cookie. */
  let sessionCookie = "";
  let cliSession = "";
  let agentToken = "";
  let appToken = "";
  let approvalId = "";
  let tunnel: { close(): Promise<void> } | null = null;
  // What cleanup has to undo. A walk that stopped before creating something must not report
  // a failed cleanup for it — the exit code is the verdict, and noise in it is a lie.
  let userExists = false;
  let appExists = false;

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
      const signedIn = await signIn(USERNAME, password);
      session = signedIn.token;
      sessionCookie = signedIn.cookie;
      return `session bearer + browser cookie issued (${session.length} chars, withheld)`;
    });

    await step("whoami", async () => {
      const me = await getJson(`${ORIGIN}/api/whoami`, session);
      expect(me.principal === `user:${USERNAME}`, `principal ${String(me.principal)}`);
      expect(me.namespace === USERNAME, `namespace ${String(me.namespace)}`);
      return `${String(me.principal)} in namespace ${String(me.namespace)}`;
    });

    await step("CLI device flow (§14) approved with the web session", async () => {
      // The /device PAGE is a later dispatch; the flow underneath it is better-auth's own
      // endpoints, and that is what the CLI speaks. The claim and the approval are the
      // browser's half — §4's mount guard admits a bearer only at the anonymous `/device/code`
      // and `/device/token` legs, never at the claim or the approval (a bearer that could
      // approve would mint a second owner session), so these two are driven over the COOKIE
      // the sign-in set, exactly as the /device page does through callAuthResponse. The
      // approval POST carries Origin so it clears better-auth's cookie-request origin check.
      const requested = await postJson(`${ORIGIN}/api/auth/device/code`, { client_id: DEVICE_CLIENT_ID });
      const userCode = asString(requested.user_code, "user_code");
      const deviceCode = asString(requested.device_code, "device_code");
      const claimed = await fetch(
        `${ORIGIN}/api/auth/device?user_code=${encodeURIComponent(userCode)}`,
        { headers: { Cookie: sessionCookie } },
      );
      expect(claimed.ok, `device claim over cookie → ${claimed.status}`);
      const approveResponse = await fetch(`${ORIGIN}/api/auth/device/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: ORIGIN },
        body: JSON.stringify({ userCode }),
      });
      const approved = asRecord(await approveResponse.json().catch(() => ({})), "device approve response");
      expect(approveResponse.ok && approved.success === true, `approve answered ${approveResponse.status} ${JSON.stringify(approved)}`);
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

    await step("pmcp agent_create", async () => {
      const created = await owner("agent_create", { slug: AGENT });
      const agent = asRecord(created.agent, "agent");
      return `agent ${String(agent.slug)}`;
    });

    await step("pmcp token_issue (pmcp_agt_)", async () => {
      const minted = await owner("token_issue", { kind: "agent", slug: AGENT });
      agentToken = asString(minted.token, "token");
      expect(agentToken.startsWith("pmcp_agt_"), "minted key is not a pmcp_agt_ token");
      return `pmcp_agt_ key ${String(minted.id)} (value withheld)`;
    });

    await step("MCP handshake as the agent", async () => {
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
      const names = asArray(listed.tools).map((tool) => String(asRecord(tool, "catalog entry").name));
      expect(
        JSON.stringify(names) === JSON.stringify(["hub_execute", "hub_search_types"]),
        `aggregate tools ${JSON.stringify(names)}`,
      );
      const serverInfo = asRecord(init.serverInfo, "serverInfo");
      return `initialize ${String(serverInfo.name)}, notifications/initialized 202, discover ${JSON.stringify(discovered.supportedVersions)}, aggregate tools ${JSON.stringify(names)}`;
    });

    await step("pmcp app_create (tunnel)", async () => {
      const created = await owner("app_create", { slug: APP, kind: "tunnel" });
      const app = asRecord(created.app, "app");
      expect(app.kind === "tunnel", `kind ${String(app.kind)}`);
      appExists = true;
      return `${String(app.slug)} (${String(app.kind)}, status ${String(app.status)})`;
    });

    await step("pmcp token_issue (pmcp_app_)", async () => {
      const minted = await owner("token_issue", { kind: "app", slug: APP });
      appToken = asString(minted.token, "token");
      expect(appToken.startsWith("pmcp_app_"), "minted key is not a pmcp_app_ token");
      return `pmcp_app_ key ${String(minted.id)} (value withheld)`;
    });

    await step("client library connects and registers", async () => {
      const app = serveOneTool(appToken, ECHO_TOOL);
      tunnel = app;
      await deadline(app.registered, 20_000, "hub/register was never accepted");
      return `registered role ${ROLE} declaring tool ${TOOL} through @personal-mcps/client`;
    });

    await step("app reports online", async () => {
      const status = await until(
        async () => asRecord((await owner("app_get", { slug: APP })).app, "app").status,
        (value) => value === "online",
        15_000,
      );
      return `app_get status ${String(status)}`;
    });

    await step("pmcp grant_set", async () => {
      const granted = await owner("grant_set", { agent: AGENT, app: APP, roles: [ROLE] });
      const warnings = asArray(granted.warnings);
      return `${AGENT} → ${APP}: [${ROLE}]${warnings.length === 0 ? "" : ` warnings ${JSON.stringify(warnings)}`}`;
    });

    await step("tools/list through the tunnel", async () => {
      const names = await until(
        async () => {
          const listed = asRecord(
            await mcp(`${ORIGIN}/${USERNAME}/mcp/${APP}`, agentToken, "tools/list"),
            "tools/list result",
          );
          return asArray(listed.tools).map((tool) => String(asRecord(tool, "catalog entry").name));
        },
        (found) => found.includes(TOOL),
        15_000,
      );
      return `scoped catalog ${JSON.stringify(names)}`;
    });

    await step("§23 · hub search_types and execute cross the deployed QuickJS boundary", async () => {
      const searched = asRecord(
        await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "tools/call", {
          name: "hub_search_types",
          arguments: { query: TOOL, surface: "program" },
        }),
        "hub_search_types result",
      );
      const search = asRecord(searched.structuredContent, "hub_search_types structuredContent");
      const matches = asArray(search.matches).map((match) => asRecord(match, "search match"));
      expect(
        matches.some((match) => match.service === APP && match.subject === TOOL),
        `hub_search_types did not expose ${APP}/${TOOL}`,
      );

      const executed = asRecord(
        await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "tools/call", {
          name: "hub_execute",
          arguments: {
            code: `
              const result = await mcp.smokeApp.echo({ text: "hub" });
              const output = result.structuredContent!;
              return { echo: output.echo, principal: output.principal };
            `,
          },
        }),
        "hub_execute result",
      );
      const execution = asRecord(executed.structuredContent, "hub_execute structuredContent");
      expect(execution.kind === "completed", `hub_execute kind ${String(execution.kind)}`);
      const value = asRecord(execution.value, "hub_execute value");
      expect(value.echo === "hub", `hub_execute echo ${String(value.echo)}`);
      expect(value.principal === `agent:${AGENT}`, `hub_execute principal ${String(value.principal)}`);
      return `${matches.length} search match(es); execution completed through mcp.smokeApp.echo`;
    });

    await step("§23 · TypeScript, schema, and exception failures are actionable", async () => {
      const execute = async (code: string): Promise<Record<string, unknown>> => {
        const called = asRecord(
          await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "tools/call", {
            name: "hub_execute",
            arguments: { code },
          }),
          "diagnostic hub_execute result",
        );
        return asRecord(called.structuredContent, "diagnostic hub_execute structuredContent");
      };

      const typed = await execute(`return await mcp.smokeApp.echo({ text: 42 });`);
      const diagnostics = asArray(typed.diagnostics).map((diagnostic) => asRecord(diagnostic, "type diagnostic"));
      expect(typed.kind === "type_error", `type failure kind ${String(typed.kind)}`);
      expect(
        diagnostics.some((diagnostic) =>
          typeof diagnostic.message === "string" &&
          diagnostic.message.includes("not assignable to type 'string'") &&
          diagnostic.line === 1),
        `type diagnostics ${JSON.stringify(diagnostics)}`,
      );

      const unknown = await execute(`return await mcp.smokeApp.ecoh({ text: "x" });`);
      const unknownDiagnostic = asRecord(asArray(unknown.diagnostics)[0], "unknown-tool diagnostic");
      expect(unknown.kind === "type_error", `unknown-tool failure kind ${String(unknown.kind)}`);
      expect(
        unknownDiagnostic.message === 'unknown tool "ecoh" on mcp.smokeApp; did you mean "echo"?',
        `unknown-tool diagnostic ${String(unknownDiagnostic.message)}`,
      );

      const syntax = await execute("return (;");
      const syntaxDiagnostic = asRecord(asArray(syntax.diagnostics)[0], "syntax diagnostic");
      expect(syntax.kind === "type_error", `syntax failure kind ${String(syntax.kind)}`);
      expect(syntaxDiagnostic.line === 1 && typeof syntaxDiagnostic.column === "number", "syntax location missing");

      const schema = await execute(`
        const input = JSON.parse('{"text":42}');
        return await mcp.smokeApp.echo(input);
      `);
      expect(schema.kind === "runtime_error", `schema failure kind ${String(schema.kind)}`);
      expect(
        typeof schema.message === "string" && schema.message.includes("input.text"),
        `schema failure message ${String(schema.message)}`,
      );
      expect(schema.mayHaveRun === false, "schema-invalid input reached dispatch");

      const runtime = await execute(`throw new Error("smoke boom");`);
      expect(runtime.kind === "runtime_error", `runtime failure kind ${String(runtime.kind)}`);
      expect(runtime.message === "smoke boom", `runtime failure message ${String(runtime.message)}`);
      expect(
        typeof runtime.stack === "string" && runtime.stack.includes("program.ts:1:"),
        `runtime failure stack ${String(runtime.stack)}`,
      );

      let timeoutRefusal: RpcError | null = null;
      try {
        await mcp(`${ORIGIN}/${USERNAME}/mcp`, agentToken, "tools/call", {
          name: "hub_execute",
          arguments: { code: "return 1;", timeout_ms: 60_000 },
        });
      } catch (err) {
        if (err instanceof RpcError) timeoutRefusal = err;
        else throw err;
      }
      expect(timeoutRefusal?.code === -32602, `over-max timeout code ${String(timeoutRefusal?.code)}`);
      const timeoutData = asRecord(timeoutRefusal?.data, "over-max timeout data");
      expect(timeoutData.field === "timeout_ms", `over-max timeout field ${String(timeoutData.field)}`);
      expect(timeoutData.max === 30_000, `over-max timeout maximum ${String(timeoutData.max)}`);
      return "typed results, concise suggestions, schema and exception diagnostics, and timeout maximum returned";
    });

    await step("tools/call through the tunnel", async () => {
      const result = asRecord(await callTool(agentToken), "tools/call result");
      const structured = asRecord(result.structuredContent, "structuredContent");
      expect(structured.echo === CALL_ARGS.text, `echo ${String(structured.echo)}`);
      expect(structured.principal === `agent:${AGENT}`, `principal ${String(structured.principal)}`);
      return `echo "${String(structured.echo)}" from ${String(structured.principal)} roles ${JSON.stringify(structured.roles)}`;
    });

    await step("§23 · aggregate subscriptions/listen holds a hub-only keepalive stream", async () => {
      // Aggregate now represents the virtual hub, whose push flags are false. The live
      // deployment proof is therefore the held SSE response and authenticated keepalive;
      // application catalog changes belong only to scoped application streams.
      const opened = await fetch(`${ORIGIN}/${USERNAME}/mcp`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${agentToken}`,
          "Content-Type": "application/json",
          // §21.1: the hub MINTS its own and never echoes this one. Sent precisely so the
          // minted id below can be checked against it.
          "Mcp-Session-Id": CLIENT_SUPPLIED_SESSION,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscriptions/listen" }),
      });
      expect(opened.status === 200, `subscriptions/listen → ${opened.status}`);
      const contentType = opened.headers.get("Content-Type") ?? "";
      expect(contentType.startsWith("text/event-stream"), `listen content-type ${contentType}`);
      const sessionId = opened.headers.get("Mcp-Session-Id") ?? "";
      expect(sessionId !== CLIENT_SUPPLIED_SESSION, "the hub echoed the client-supplied Mcp-Session-Id");
      expect(UUID_SHAPED.test(sessionId), `minted Mcp-Session-Id ${sessionId}`);
      if (opened.body === null) throw new Error("subscriptions/listen answered 200 with no body");
      const stream = sseBlocks(opened.body);

      try {
        // A live stream says so with a byte, not a header (§21.1's open).
        const first = await stream.next(30_000);
        expect(first.startsWith(":"), `the opened stream's first block was ${JSON.stringify(first)}`);
        return `stream ${sessionId} (mint, not the supplied ${CLIENT_SUPPLIED_SESSION}); authenticated keepalive received`;
      } finally {
        // Closing the consumer's end ends the held response. Aggregate hub streams open no
        // application subscriber sockets because the virtual hub advertises no push.
        await stream.close();
      }
    });

    await step("approval mode refuses the call (-32003)", async () => {
      await owner("grant_set", { agent: AGENT, app: APP, roles: [`${ROLE}:approval`] });
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

    await step("§13 · the /apps shell renders for the browser session, and its API answers behind the same cookie", async () => {
      // The one page leg, as the SPA shape makes it two. `/apps` is a shell document now:
      // it reads nothing, so what it proves is the gate and the bundle's entry points, and
      // the read the page used to perform is a JSON call this step makes itself. Both,
      // because a deployment can ship one and not the other — a shell whose API 500s is a
      // blank screen, and an API behind a shell that never loaded is invisible.
      const rendered = await fetch(`${ORIGIN}/apps`, { headers: { Cookie: sessionCookie } });
      expect(rendered.status === 200, `authenticated /apps → ${rendered.status}`);
      const html = await rendered.text();
      expect(html.includes(`id="pmcp-bootstrap"`), "/apps carried no bootstrap island");
      expect(html.includes(`src="/app.js"`), "/apps linked no client bundle");
      expect(rendered.headers.get("cache-control") === "no-store", `/apps Cache-Control ${rendered.headers.get("cache-control") ?? ""}`);

      // The read itself: the app the walk just created, through the resource the client
      // reads — the same `app_list` the `pmcp` tools front.
      const listed = await hubJson("/api/hub/apps", sessionCookie);
      const slugs = asArray(listed.apps).map((app) => String(asRecord(app, "app row").slug));
      expect(slugs.includes(APP), `GET /api/hub/apps listed no ${APP} (${JSON.stringify(slugs)})`);

      const anonymous = await fetch(`${ORIGIN}/apps`, { redirect: "manual" });
      expect(
        anonymous.status === 302 && (anonymous.headers.get("location") ?? "").startsWith("/login"),
        `unauthenticated /apps → ${anonymous.status} ${anonymous.headers.get("location") ?? ""}`,
      );
      // And the API's own refusal is a JSON 401, not that redirect: a fetch cannot follow
      // one into the address bar, so the two surfaces refuse differently on purpose.
      const noCookie = await fetch(`${ORIGIN}/api/hub/apps`, { redirect: "manual" });
      expect(noCookie.status === 401, `unauthenticated /api/hub/apps → ${noCookie.status}`);

      return `/apps 200 no-store with the bootstrap island and /app.js; GET /api/hub/apps lists ${APP}; no cookie → ${anonymous.status} ${anonymous.headers.get("location") ?? ""} and 401 on the API`;
    });

    await step("§13 · the client bundle the shell links is actually served", async () => {
      // The asset binding is a deployment fact and nothing else: the suite runs against a
      // built `web/dist`, and only a live origin says the same files shipped. A 404 here
      // is a blank dashboard with a green suite behind it.
      const script = await fetch(`${ORIGIN}/app.js`);
      expect(script.status === 200, `/app.js → ${script.status}`);
      expect(
        (script.headers.get("content-type") ?? "").includes("javascript"),
        `/app.js content-type ${script.headers.get("content-type") ?? ""}`,
      );
      const sheet = await fetch(`${ORIGIN}/app.css`);
      expect(sheet.status === 200, `/app.css → ${sheet.status}`);
      expect(
        (sheet.headers.get("content-type") ?? "").includes("text/css"),
        `/app.css content-type ${sheet.headers.get("content-type") ?? ""}`,
      );
      return `/app.js 200 ${script.headers.get("content-type") ?? ""}; /app.css 200 ${sheet.headers.get("content-type") ?? ""}`;
    });

    await step("§13 · the /settings panes render behind the prefix gate, and the old paths answer as pinned", async () => {
      // D15's page legs. The suite owns the panes' content; the deployment can still get
      // the ROUTING wrong (a pane 404ing, the 301 not shipping, the prefix gate reading a
      // bearer), and only a walk over the real origin says so. The bearer leg carries the
      // device-flow session as a header and nothing else — §13's gate never reads
      // Authorization, so it must bounce to /login exactly as an anonymous request does.
      const withCookie = { headers: { Cookie: sessionCookie }, redirect: "manual" as const };
      const settings = await fetch(`${ORIGIN}/settings`, withCookie);
      expect(settings.status === 200, `authenticated /settings → ${settings.status}`);
      const rail = await settings.text();
      for (const pane of ["/settings/two-factor", "/settings/passkeys", "/settings/sessions", "/settings/tokens", "/settings/clients"]) {
        expect(rail.includes(`href="${pane}"`), `/settings rail links no ${pane}`);
      }
      const clients = await fetch(`${ORIGIN}/settings/clients`, withCookie);
      expect(clients.status === 200, `authenticated /settings/clients → ${clients.status}`);
      // The two-factor pane is the one whose render needs a QR encoder shipped with the
      // bundle: a deployment missing it answers 500 where the suite is green. The fresh
      // namespace has no factor, so the arm this walk always meets is the not-enrolled
      // one, and its own control is what says the card drew rather than just the shell.
      const twoFactor = await fetch(`${ORIGIN}/settings/two-factor`, withCookie);
      expect(twoFactor.status === 200, `authenticated /settings/two-factor → ${twoFactor.status}`);
      expect(
        (await twoFactor.text()).includes("Enable two-factor"),
        "/settings/two-factor rendered no Enable two-factor control",
      );
      const alias = await fetch(`${ORIGIN}/settings/password`, withCookie);
      expect(alias.status === 404, `/settings/password (no alias, §13) → ${alias.status}`);
      const moved = await fetch(`${ORIGIN}/oauth/connections`, withCookie);
      expect(
        moved.status === 301 && moved.headers.get("location") === "/settings/clients",
        `/oauth/connections → ${moved.status} ${moved.headers.get("location") ?? ""}`,
      );
      const bearerOnly = await fetch(`${ORIGIN}/settings/change-password`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "csrf=none",
        redirect: "manual",
      });
      expect(
        bearerOnly.status === 302 && (bearerOnly.headers.get("location") ?? "").startsWith("/login"),
        `bearer-only POST /settings/change-password → ${bearerOnly.status} ${bearerOnly.headers.get("location") ?? ""}`,
      );
      return `/settings 200 with the six-pane rail; /settings/clients 200; /settings/two-factor 200 drawing the Enable control; /settings/password 404; /oauth/connections 301 → /settings/clients; bearer-only change-password → 302 /login`;
    });

    await step("§13 · /agents answers the shell and its API reports the agent with the grant it holds", async () => {
      // Step 9's two legs, in their SPA shape: the routes answer the shell document, and
      // the reads the pages used to make — agent_list, connection_list — are now the two
      // resources under /api/hub/agents. The deployment can still get the routing wrong
      // (a route unmounted, the pair page 404ing on a real pair), and only a walk says so.
      const withCookie = { headers: { Cookie: sessionCookie }, redirect: "manual" as const };
      for (const url of [`/agents`, `/agents/${AGENT}`, `/agents/${AGENT}/apps/${APP}`]) {
        const answered = await fetch(`${ORIGIN}${url}`, withCookie);
        expect(answered.status === 200, `authenticated ${url} → ${answered.status}`);
        expect((await answered.text()).includes(`id="pmcp-bootstrap"`), `${url} carried no bootstrap island`);
      }
      // An (agent × app) pair the walk never granted is the document-level 404 the shell
      // decides BEFORE it emits anything — the check that has to survive the cutover.
      const missing = await fetch(`${ORIGIN}/agents/${AGENT}/apps/smoke-no-such-app`, withCookie);
      expect(missing.status === 404, `/agents/${AGENT}/apps/smoke-no-such-app → ${missing.status}`);

      const listed = await hubJson("/api/hub/agents", sessionCookie);
      const slugs = asArray(listed.agents).map((agent) => String(asRecord(agent, "agent row").slug));
      expect(slugs.includes(AGENT), `GET /api/hub/agents listed no ${AGENT} (${JSON.stringify(slugs)})`);

      const one = await hubJson(`/api/hub/agents/${AGENT}`, sessionCookie);
      const grants = asRecord(asRecord(one.agent, "agent").grants, "grants");
      expect(
        asStrings(grants[APP]).some((entry) => entry === ROLE || entry === `${ROLE}:approval`),
        `GET /api/hub/agents/${AGENT} shows no ${ROLE} on ${APP} (${JSON.stringify(grants)})`,
      );
      return `/agents, /agents/${AGENT} and its ${APP} pane all 200 shells, an ungranted pair 404; GET /api/hub/agents lists ${AGENT} holding ${JSON.stringify(grants[APP])} on ${APP}`;
    });

    await step("§13 · the install icon the manifest declares is real PNG bytes at its declared size", async () => {
      // The suite reads these bytes under Vite; only the deployment says the bundle carries
      // them too (an asset import handing back a URL string is the divergence the packaging
      // refuses). A browser that finds no icon shows no install affordance and no error.
      const icon = await fetch(`${ORIGIN}/icon-512.png`);
      expect(icon.status === 200, `/icon-512.png → ${icon.status}`);
      expect(icon.headers.get("content-type") === "image/png", `/icon-512.png content-type ${icon.headers.get("content-type") ?? ""}`);
      const bytes = new Uint8Array(await icon.arrayBuffer());
      const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b);
      const width = new DataView(bytes.buffer).getUint32(16);
      expect(signature && width === 512, `/icon-512.png is not a 512-wide PNG (${bytes.length} bytes, width ${width})`);
      return `/icon-512.png 200 image/png, PNG signature, IHDR width 512, ${bytes.length} bytes`;
    });

    await step("§13 · the passkey options endpoint answers a challenge within seconds", async () => {
      // 2026-09-03: a stuck production instance hung exactly this endpoint — and every other
      // path where better-auth signs or verifies a cookie — for minutes until the client gave
      // up, while the rest of the surface answered. Nothing in the suite can see a wedged
      // isolate; only a bounded live call can. The bound is generous: a healthy answer is
      // ~100 ms, a stuck one never comes.
      const started = Date.now();
      const options = await fetch(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const took = Date.now() - started;
      expect(options.status === 200, `passkey options → ${options.status} after ${took} ms`);
      const body = (await options.json()) as { challenge?: unknown; rpId?: unknown };
      expect(typeof body.challenge === "string" && body.challenge.length > 0, "passkey options carried no challenge");
      return `200 in ${took} ms, challenge present, rpId ${String(body.rpId ?? "(absent)")}`;
    });

    await step("§4/§15 · /login's ?next= is escaped where it is embedded and refused where it is absolute", async () => {
      // The suite pins both consumers against miniflare; only the deployment says whether
      // the bytes that reach a real browser are the escaped ones. Hostile spelling first —
      // a value that PASSES the hub-relative rule and so reaches the inline script.
      const injected = await fetch(`${ORIGIN}/login?next=/apps%3C/script%3E%3Cimg%20src=x%3E`);
      expect(injected.status === 200, `/login with an injected next= → ${injected.status}`);
      const html = await injected.text();
      // The payload's own bytes, not a bare `</script><` — the passkey script is the last
      // child of .auth-card, so `</script></div>` puts that pair in every /login response.
      expect(
        !html.includes("</script><img") && !html.includes("<img src=x"),
        "/login embedded the raw payload from ?next=",
      );
      // Then the open-redirect half: an absolute target reaches no embed at all.
      const absolute = await fetch(`${ORIGIN}/login?next=https://evil.example`);
      expect(absolute.status === 200, `/login with an absolute next= → ${absolute.status}`);
      const callbackUrl = /name="callbackURL"\s+value="([^"]*)"/.exec(await absolute.text())?.[1];
      expect(callbackUrl === "/apps", `absolute next= rendered callbackURL "${callbackUrl ?? "(none)"}"`);
      return `injected next= carries no "</script><img" and no "<img src=x"; absolute next= → callbackURL /apps`;
    });

    await step(`§13 · GET /api/hub/apps/${APP}/catalog/tools reports the app's registered catalog`, async () => {
      // The tunnel leg above registered `echo` over the real client library, and this is
      // the read the Catalog pane makes: the DO's cached catalog through the door's own
      // listing (§13, §20.6). The tool's name coming back is the deployment's DO, D1 and
      // JSON surface agreeing about one fact — the same fact the page used to render.
      const answered = await fetch(`${ORIGIN}/apps/${APP}`, { headers: { Cookie: sessionCookie } });
      expect(answered.status === 200, `authenticated /apps/${APP} → ${answered.status}`);
      expect((await answered.text()).includes(`id="pmcp-bootstrap"`), `/apps/${APP} carried no bootstrap island`);

      const catalog = await hubJson(`/api/hub/apps/${APP}/catalog/tools`, sessionCookie);
      const names = asArray(catalog.items).map((item) => String(asRecord(item, "catalog item").name));
      expect(names.includes(TOOL), `catalog/tools lists no ${TOOL} (${JSON.stringify(names)})`);
      // The derivation the panes draw from rides the same answer, one entry per item, and
      // its `subject` is the canonical identity the details keep separate from the
      // generated TypeScript path.
      const derived = asArray(catalog.derived).map((row) => String(asRecord(row, "derivation").subject));
      expect(
        derived.length === names.length && derived.includes(TOOL),
        `catalog/tools derived ${JSON.stringify(derived)} for ${JSON.stringify(names)}`,
      );

      // The Catalog holds prompts and resources now, so their old pane URLs are permanent
      // moves onto it — while /tools stays the 404 it has always been.
      const moved = await fetch(`${ORIGIN}/apps/${APP}/prompts`, { headers: { Cookie: sessionCookie }, redirect: "manual" });
      expect(moved.status === 301, `/apps/${APP}/prompts (301 to the Catalog, §2) → ${moved.status}`);
      expect(
        moved.headers.get("location") === `/apps/${APP}/catalog`,
        `/apps/${APP}/prompts → ${moved.headers.get("location") ?? "(no Location)"}`,
      );
      const alias = await fetch(`${ORIGIN}/apps/${APP}/tools`, { headers: { Cookie: sessionCookie }, redirect: "manual" });
      expect(alias.status === 404, `/apps/${APP}/tools (no alias, §2) → ${alias.status}`);
      return `/apps/${APP} 200 shell; GET /api/hub/apps/${APP}/catalog/tools lists ${TOOL} with ${derived.length} derivation(s); /apps/${APP}/prompts → 301 /apps/${APP}/catalog; /apps/${APP}/tools → 404`;
    });

    await step("§13 · audit_query sees the calls, and the /audit explorer's shell and window read answer for the browser session", async () => {
      const rows = asArray((await owner("audit_query", { app: APP })).rows);
      const calls = rows.filter((row) => asRecord(row, "audit row").event === "tools/call");
      expect(calls.length >= 2, `only ${calls.length} tools/call rows`);
      const events = rows.map((row) => String(asRecord(row, "audit row").event));

      // `/audit` is the SPA's third family (decision 36), so the page leg is the same two
      // halves `/apps` has: the shell document, and the read the client makes behind the
      // same cookie. A shell whose window read 500s is a blank screen on a live hub, and
      // only the deployed worker can tell us the D1 projection actually runs there.
      const rendered = await fetch(`${ORIGIN}/audit`, { headers: { Cookie: sessionCookie } });
      expect(rendered.status === 200, `authenticated /audit → ${rendered.status}`);
      const html = await rendered.text();
      expect(html.includes(`id="pmcp-bootstrap"`), "/audit carried no bootstrap island");
      expect(html.includes(`src="/app.js"`), "/audit linked no client bundle");
      expect(
        rendered.headers.get("cache-control") === "no-store",
        `/audit Cache-Control ${rendered.headers.get("cache-control") ?? ""}`,
      );

      const windowRead = await hubJson("/api/hub/audit/window", sessionCookie);
      const slim = asArray(windowRead.rows).map((row) => asRecord(row, "slim audit row"));
      expect(Number(windowRead.total) >= rows.length, `window total ${String(windowRead.total)} < ${rows.length}`);
      expect(slim.length > 0, "the window read answered no rows");
      // The whole point of the body-less projection: a listing of thousands must never carry
      // a body. One row carrying one would be invisible until the Worker ran out of memory.
      for (const row of slim) {
        expect(!("args" in row) && !("result" in row), `a window row shipped a body: ${JSON.stringify(row).slice(0, 120)}`);
      }
      expect(Number(windowRead.ceiling) > 0 && Number(windowRead.until) > Number(windowRead.since), "the window read echoed no window");

      return `${rows.length} rows for ${APP}, ${calls.length} tools/call — ${JSON.stringify(unique(events))}; /audit 200 no-store with the bootstrap island; GET /api/hub/audit/window ${slim.length} slim rows of ${String(windowRead.total)}, ceiling ${String(windowRead.ceiling)}`;
    });

    await step(
      "SMOKE · §19 · the full OAuth round-trip mints a JWT that reaches tools/call as agent:<slug> on both endpoint shapes, and revoking it stops the next call",
      async () => {
        // One step, one atomic leg: a mid-walk failure here must not print as a run of
        // separate passing steps — it is one claim, "the OAuth connector flow works end to
        // end against this deployment", or it is not.
        const resource = `${ORIGIN}/${USERNAME}/mcp`;

        // Discovery, anonymous — no Authorization header anywhere in this walk (§19.7): if
        // it needed one, the allowlist argument the whole flow rests on would be wrong.
        const prm = await getPublicJson(`${ORIGIN}/.well-known/oauth-protected-resource/${USERNAME}/mcp`);
        expect(prm.resource === resource, `PRM resource ${String(prm.resource)}`);
        expect(
          asArray(prm.authorization_servers)[0] === ORIGIN,
          `PRM authorization_servers ${JSON.stringify(prm.authorization_servers)}`,
        );
        const asMeta = await getPublicJson(`${ORIGIN}/.well-known/oauth-authorization-server`);
        expect(asMeta.issuer === ORIGIN, `AS metadata issuer ${String(asMeta.issuer)}`);

        // DCR: a fresh public client, server-assigned id — no session, no bearer, nothing
        // typed by an operator (§19.3).
        const registered = await postJson(`${ORIGIN}/api/auth/oauth2/register`, {
          client_name: "pmcp-smoke-oauth",
          redirect_uris: [OAUTH_REDIRECT_URI],
          token_endpoint_auth_method: "none",
        });
        const clientId = asString(registered.client_id, "client_id");

        // PKCE S256, required of every client (§19.3).
        const verifier = base64url(randomBytes(48));
        const challenge = base64url(createHash("sha256").update(verifier).digest());
        const state = base64url(randomBytes(16));

        // ANONYMOUS authorize — no session at all (§19.5 step 1). This leg's failure modes
        // are deployment-only: real cookie flags, better-auth's own origin check on the
        // /login POST, a signed query surviving an actual redirect chain on the deployed
        // origin — none of which miniflare's web-pages.test.ts can witness, so the walk is
        // the one place it is driven for real rather than reused from the earlier `sign in`
        // step's cookie.
        const authorizeUrl = `${ORIGIN}/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_challenge: challenge,
          code_challenge_method: "S256",
          scope: "mcp",
          resource,
          state,
        }).toString()}`;
        const anonymousAuthorize = await fetch(authorizeUrl, { redirect: "manual" });
        const loginLocation = await redirectTarget(anonymousAuthorize);
        expect(
          loginLocation.includes("/login"),
          `anonymous authorize → ${anonymousAuthorize.status} ${loginLocation}`,
        );

        // /login itself: its OWN rendered callbackURL — the post-sign-in landing the page
        // built from the signed query, never a `next=`/`return_to=` this walk supplies
        // (§19.5 step 1's whole point — the login page never reads a destination out of
        // the query it was handed).
        const loginPageUrl = new URL(loginLocation, ORIGIN).toString();
        const loginHtml = await (await fetch(loginPageUrl)).text();
        const callbackUrl = hiddenField(loginHtml, "callbackURL");
        expect(callbackUrl.includes("/oauth2/authorize"), `login page callbackURL ${callbackUrl}`);

        // Sign in as the bootstrap user through the PAGE's own translation route
        // (`/login/sign-in/username`, form-encoded — better-auth's router itself takes only
        // JSON) — not `mutation`'s gate: there is no session yet to derive a CSRF token
        // from, which is exactly why this POST is guarded by the browser's SameSite cookie
        // semantics and the origin check instead (web.ts's own doc on the credential
        // family). The Set-Cookie on its redirect is a FRESH session, captured here rather
        // than reused from the walk's earlier `sign in` step.
        const signedIn = await fetch(`${ORIGIN}/login/sign-in/username`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
          body: new URLSearchParams({ username: USERNAME, password, callbackURL: callbackUrl }),
        });
        const browserCookie = signedIn.headers
          .getSetCookie()
          .map((header) => header.split(";")[0])
          .join("; ");
        expect(browserCookie !== "", "sign-in through /login set no session cookie");
        // The post-login destination is the callbackURL the login page already built from the
        // signed query (§19.5 step 1) — so a successful sign-in returns exactly it, whether as
        // a 302 Location or the fetch envelope. Falls back to the scraped callbackURL when the
        // sign-in answers success without echoing a redirect at all.
        const backToAuthorize = (await redirectTarget(signedIn)) || callbackUrl;
        expect(
          signedIn.status < 400 && backToAuthorize.includes("/oauth2/authorize"),
          `login POST → ${signedIn.status} ${backToAuthorize}`,
        );

        // Back at `authorize`, now WITH the fresh session and no covering consent — §19.5
        // step 2, the provider re-running the SAME signed query it built at step 1.
        const toConsent = await fetch(new URL(backToAuthorize, ORIGIN).toString(), {
          redirect: "manual",
          headers: { Cookie: browserCookie },
        });
        const consentLocation = await redirectTarget(toConsent);
        expect(
          consentLocation.includes("/oauth/consent"),
          `authorize (signed in) → ${toConsent.status} ${consentLocation}`,
        );

        // The consent page itself: its own CSRF token, and the oauth_query it can only
        // echo — never invent, drop or edit (§19.5 step 2).
        const consentPageUrl = new URL(consentLocation, ORIGIN).toString();
        const consentHtml = await (await fetch(consentPageUrl, { headers: { Cookie: browserCookie } })).text();
        const csrf = hiddenField(consentHtml, "csrf");
        const oauthQuery = hiddenField(consentHtml, "oauth_query");

        // An agent THIS step creates and grants, so the scoped call below rides on
        // a grant this step controls — never on whatever approval state the main flow left
        // `AGENT` in.
        await owner("agent_create", { slug: OAUTH_AGENT });
        await owner("grant_set", { agent: OAUTH_AGENT, app: APP, roles: [ROLE] });

        const consentPost = await fetch(`${ORIGIN}/oauth/consent`, {
          method: "POST",
          redirect: "manual",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Cookie: browserCookie,
            // Clears better-auth's cookie-request origin check downstream, the same reason
            // the device-approval POST above carries it.
            Origin: ORIGIN,
          },
          body: new URLSearchParams({ csrf, oauth_query: oauthQuery, agent: OAUTH_AGENT, decision: "accept" }),
        });
        const codeLocation = await redirectTarget(consentPost);
        expect(
          codeLocation.startsWith(OAUTH_REDIRECT_URI),
          `consent → ${consentPost.status} ${codeLocation}`,
        );
        const redirectParams = new URL(codeLocation).searchParams;
        const code = redirectParams.get("code") ?? "";
        expect(code !== "", "consent redirect carried no code");
        // §19.3: every redirect names the issuer, so Claude Code's v2 runtime does not fail
        // the sign-in on an unexpected one.
        expect(redirectParams.get("iss") === ORIGIN, `redirect iss ${redirectParams.get("iss")}`);

        // /oauth2/token: the verifier and the SAME resource an MCP client sends on both
        // legs (§19.6 step 2) — omitting either is the opaque-token failure mode this walk
        // is not the one testing. The token endpoint is form-encoded (RFC 6749 §4.1.3), the
        // shape a real OAuth client sends; JSON is refused 415, so this is not postJson.
        const tokenResponse = await fetch(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            redirect_uri: OAUTH_REDIRECT_URI,
            client_id: clientId,
            code_verifier: verifier,
            resource,
          }),
        });
        if (!tokenResponse.ok) {
          throw new Error(`token endpoint → ${tokenResponse.status} ${(await tokenResponse.text()).slice(0, 200)}`);
        }
        const tokenAnswer = (await tokenResponse.json()) as Record<string, unknown>;
        const accessToken = asString(tokenAnswer.access_token, "access_token");
        expect(jwtShaped(accessToken), "the minted access token is not JWT-shaped (§7/§19.6's own predicate)");
        const aud = jwtPayload(accessToken).aud;
        const audValues = Array.isArray(aud) ? aud : [aud];
        expect(audValues.includes(resource), `access token aud ${JSON.stringify(aud)}`);

        // The aggregate hub endpoint, and the SAME token scoped to the tunneled app — the
        // audience is namespace-wide (§19.6 step 3), so both endpoint shapes accept it.
        const aggregate = asRecord(await mcp(`${ORIGIN}/${USERNAME}/mcp`, accessToken, "tools/list"), "tools/list result");
        const aggregateNames = asArray(aggregate.tools).map((tool) => String(asRecord(tool, "catalog entry").name));
        expect(
          JSON.stringify(aggregateNames) === JSON.stringify(["hub_execute", "hub_search_types"]),
          `aggregate tools/list ${JSON.stringify(aggregateNames)}`,
        );

        // Both live OAuth bearers resolve to the same binding and agent. Execute through
        // each credential to prove the in-Worker runtime accepts either reference without
        // retaining or keying isolation on the bearer itself.
        const originalExecution = asRecord(
          await mcp(`${ORIGIN}/${USERNAME}/mcp`, accessToken, "tools/call", {
            name: "hub_execute",
            arguments: { code: `return "oauth-original";` },
          }),
          "original OAuth hub_execute result",
        );
        const originalResult = asRecord(originalExecution.structuredContent, "original OAuth execution");
        expect(
          originalResult.kind === "completed",
          `the original OAuth bearer did not complete: ${JSON.stringify(originalResult)}`,
        );

        const rotatedVerifier = base64url(randomBytes(48));
        const rotatedChallenge = base64url(createHash("sha256").update(rotatedVerifier).digest());
        const rotatedAuthorizeUrl = `${ORIGIN}/api/auth/oauth2/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_challenge: rotatedChallenge,
          code_challenge_method: "S256",
          scope: "mcp",
          resource,
          state: base64url(randomBytes(16)),
        }).toString()}`;
        const rotatedAuthorize = await fetch(rotatedAuthorizeUrl, {
          redirect: "manual",
          headers: { Cookie: browserCookie },
        });
        let rotatedLocation = await redirectTarget(rotatedAuthorize);
        if (rotatedLocation.includes("/oauth/consent")) {
          const rotatedConsentUrl = new URL(rotatedLocation, ORIGIN).toString();
          const rotatedConsentHtml = await (await fetch(rotatedConsentUrl, {
            headers: { Cookie: browserCookie },
          })).text();
          const rotatedConsent = await fetch(`${ORIGIN}/oauth/consent`, {
            method: "POST",
            redirect: "manual",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Cookie: browserCookie,
              Origin: ORIGIN,
            },
            body: new URLSearchParams({
              csrf: hiddenField(rotatedConsentHtml, "csrf"),
              oauth_query: hiddenField(rotatedConsentHtml, "oauth_query"),
              agent: OAUTH_AGENT,
              decision: "accept",
            }),
          });
          rotatedLocation = await redirectTarget(rotatedConsent);
        }
        expect(rotatedLocation.startsWith(OAUTH_REDIRECT_URI), `rotated authorize → ${rotatedLocation}`);
        const rotatedCode = new URL(rotatedLocation).searchParams.get("code") ?? "";
        expect(rotatedCode !== "", "rotated authorization carried no code");
        const rotatedResponse = await fetch(`${ORIGIN}/api/auth/oauth2/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: rotatedCode,
            redirect_uri: OAUTH_REDIRECT_URI,
            client_id: clientId,
            code_verifier: rotatedVerifier,
            resource,
          }),
        });
        if (!rotatedResponse.ok) {
          throw new Error(`rotated token endpoint → ${rotatedResponse.status} ${(await rotatedResponse.text()).slice(0, 200)}`);
        }
        const rotatedAnswer = (await rotatedResponse.json()) as Record<string, unknown>;
        const rotatedAccessToken = asString(rotatedAnswer.access_token, "rotated access_token");
        expect(rotatedAccessToken !== accessToken, "second authorization returned the original bearer");
        const rotatedExecution = asRecord(
          await mcp(`${ORIGIN}/${USERNAME}/mcp`, rotatedAccessToken, "tools/call", {
            name: "hub_execute",
            arguments: { code: `return "oauth-rotated";` },
          }),
          "rotated OAuth hub_execute result",
        );
        const rotatedResult = asRecord(rotatedExecution.structuredContent, "rotated OAuth execution");
        expect(
          rotatedResult.kind === "completed",
          `the rotated OAuth bearer did not complete: ${JSON.stringify(rotatedResult)}`,
        );
        const scoped = asRecord(
          await mcp(`${ORIGIN}/${USERNAME}/mcp/${APP}`, rotatedAccessToken, "tools/call", {
            name: TOOL,
            arguments: CALL_ARGS,
          }),
          "scoped tools/call result",
        );
        const structured = asRecord(scoped.structuredContent, "structuredContent");
        expect(structured.principal === `agent:${OAUTH_AGENT}`, `scoped call principal ${String(structured.principal)}`);

        // The audit trail names the bound AGENT, never the client or the token (§19.6
        // step 5 — nothing downstream branches on how the credential arrived).
        const rows = asArray((await owner("audit_query", { principal: `agent:${OAUTH_AGENT}` })).rows);
        const calls = rows.filter((row) => asRecord(row, "audit row").event === "tools/call");
        expect(calls.length > 0, `audit_query found no tools/call rows for agent:${OAUTH_AGENT}`);

        // Revoke — immediate at the door (§19.6): the connection's next call gets the SAME
        // 401 challenge as no token at all.
        const connections = asArray((await owner("connection_list")).connections);
        // LIVE bindings only: `connection_list` keeps revoked rows (§13's Connected clients
        // pane shows them), so an earlier run's revoked row would be picked here and its
        // post-revoke 401 below would prove nothing.
        const connection = connections.find((row) => {
          const record = asRecord(row, "connection row");
          return record.agentSlug === OAUTH_AGENT && record.revokedAt === null;
        });
        if (connection === undefined) throw new Error(`connection_list carries no row for ${OAUTH_AGENT}`);
        await owner("connection_revoke", { id: String(asRecord(connection, "connection row").id) });

        const refused = await fetch(`${ORIGIN}/${USERNAME}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${rotatedAccessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(refused.status === 401, `post-revoke call → ${refused.status}`);
        expect(
          (refused.headers.get("WWW-Authenticate") ?? "").includes("resource_metadata"),
          `post-revoke challenge: ${refused.headers.get("WWW-Authenticate") ?? ""}`,
        );

        return `client ${clientId} → aud ${resource}; original + rotated OAuth bearers each completed in fresh QuickJS runtimes; scoped tools/call as agent:${OAUTH_AGENT}; ${calls.length} audit row(s); revoked → 401 with challenge`;
      },
    );

    await step("§4 · a complete TOTP sign-in stays bounded and leaves the Worker responsive", async () => {
      const enable = await fetch(`${ORIGIN}/api/auth/two-factor/enable`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: sessionCookie, Origin: ORIGIN },
        body: JSON.stringify({ password }),
        signal: AbortSignal.timeout(10_000),
      });
      const enabled = asRecord(await enable.json().catch(() => ({})), "two-factor enable response");
      expect(enable.ok, `two-factor enable → ${enable.status}`);
      const totpUri = new URL(asString(enabled.totpURI, "totpURI"));
      const secret = asString(totpUri.searchParams.get("secret"), "TOTP secret");

      const enrollment = await verifyTotp(secret, sessionCookie);
      session = enrollment.token;
      sessionCookie = enrollment.cookie;

      const passwordResponse = await fetch(`${ORIGIN}/api/auth/sign-in/username`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USERNAME, password }),
        signal: AbortSignal.timeout(10_000),
      });
      const challenged = asRecord(await passwordResponse.json().catch(() => ({})), "two-factor challenge response");
      expect(passwordResponse.ok && challenged.twoFactorRedirect === true, `password challenge → ${passwordResponse.status}`);
      const challengeCookie = responseCookies(passwordResponse);
      expect(challengeCookie !== "", "password challenge set no cookie");

      const signedIn = await verifyTotp(secret, challengeCookie);
      session = signedIn.token;
      sessionCookie = signedIn.cookie;
      const page = await fetch(`${ORIGIN}/apps`, {
        headers: { Cookie: sessionCookie },
        signal: AbortSignal.timeout(10_000),
      });
      expect(page.status === 200, `post-TOTP /apps → ${page.status}`);
      const challenge = await fetch(`${ORIGIN}/api/auth/passkey/generate-authenticate-options`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const challengeBody = asRecord(await challenge.json().catch(() => ({})), "post-TOTP passkey challenge");
      expect(challenge.ok && typeof challengeBody.challenge === "string", `post-TOTP cookie signing → ${challenge.status}`);
      return "enrolled, password challenged, TOTP verified, /apps 200, next cookie signature 200";
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
    step("cleanup: delete the app", async () => {
      if (!appExists) return "no app to delete";
      await owner("app_delete", { slug: APP });
      const slugs = asArray((await owner("app_list")).apps).map((row) =>
        String(asRecord(row, "app_list row").slug),
      );
      expect(!slugs.includes(APP), `app_list still lists ${APP}`);
      return `${APP} gone; app_list ${JSON.stringify(slugs)}`;
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

/** §4's password sign-in, which hands out BOTH carriers of one session: better-auth's
 *  bearer plugin answers with the token in the `set-auth-token` header (the body carries
 *  it too), and the same response sets the signed browser cookie — the only credential
 *  the §13 pages ever accept. */
async function signIn(username: string, password: string): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${ORIGIN}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!response.ok) throw new Error(`sign-in → ${response.status} ${await response.text()}`);
  const body = asRecord(await response.json(), "sign-in response");
  const token = response.headers.get("set-auth-token") ?? body.token;
  if (typeof token !== "string" || token === "") throw new Error("sign-in carried no session token");
  // Every cookie the sign-in set, sent back together — what a browser does, without
  // duplicating better-auth's cookie names here.
  const cookie = responseCookies(response);
  if (cookie === "") throw new Error("sign-in set no session cookie");
  return { token, cookie };
}

/** Every cookie a better-auth response set, returned in the carrier the next request
 * sends. Cookie names are deliberately not duplicated here. */
function responseCookies(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
}

/** The authenticator half of RFC 6238 using Node's crypto and better-auth's defaults:
 * HMAC-SHA1, six digits, 30-second steps. */
function totpCode(secret: string, at: number = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const symbol of secret.replace(/=+$/, "").toUpperCase()) {
    const index = alphabet.indexOf(symbol);
    if (index < 0) throw new Error("TOTP secret is not base32");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** One bounded TOTP verification, for both enrollment and sign-in challenge. */
async function verifyTotp(secret: string, cookie: string): Promise<{ token: string; cookie: string }> {
  const response = await fetch(`${ORIGIN}/api/auth/two-factor/verify-totp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: ORIGIN },
    body: JSON.stringify({ code: totpCode(secret) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = asRecord(await response.json().catch(() => ({})), "TOTP verify response");
  expect(response.ok, `TOTP verify → ${response.status}`);
  const token = asString(response.headers.get("set-auth-token") ?? body.token, "TOTP session token");
  const nextCookie = responseCookies(response);
  expect(nextCookie !== "", "TOTP verify set no session cookie");
  return { token, cookie: nextCookie };
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

/** One `/api/hub` read, as the browser client makes it: the session COOKIE and nothing
 *  else. A bearer is deliberately not a credential on this surface — it is the pages'
 *  own gate, split in two (§13) — so the cookie is what the walk has to carry. */
async function hubJson(path: string, cookie: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${ORIGIN}${path}`, { headers: { Cookie: cookie } });
  if (!response.ok) throw new Error(`GET ${path} → ${response.status} ${await response.text()}`);
  return asRecord(await response.json(), `GET ${path} response`);
}

/** One anonymous GET — §19.2's two well-known documents carry no credential and want
 *  none: a browser-side client fetching them cross-origin is the supported discovery path. */
async function getPublicJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
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

/** One §8 admin op through the builtin `pmcp` app, as the owner. */
async function adminOp(session: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = asRecord(
    await mcp(`${ORIGIN}/${USERNAME}/mcp/pmcp`, session, "tools/call", { name, arguments: args }),
    `${name} result`,
  );
  return asRecord(result.structuredContent, `${name} structuredContent`);
}

/** The walk's one tunneled call, spelled once so the approval retry is byte-identical. */
async function callTool(bearer: string): Promise<unknown> {
  return mcp(`${ORIGIN}/${USERNAME}/mcp/${APP}`, bearer, "tools/call", {
    name: TOOL,
    arguments: CALL_ARGS,
  });
}

// ── the one tunneled app, served through the real client library ──────────────────

/** The one tool this walk serves. `run` returns the STRUCTURED value; both carriers of the
 *  2026-07-28 result (text and structuredContent) are built from it. */
type SmokeTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** The structured result shape advertised to the hub and rendered into program types. */
  outputSchema: Record<string, unknown>;
  run(args: Record<string, unknown>, who: { principal: string; roles: readonly string[] }): unknown;
};

/**
 * Run one tool as a tunneled app on `@personal-mcps/client`'s transport. The library
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
      result: {
        tools: [{
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
        }],
      },
    };
  }
  const params = asRecord(frame.params, "params");
  if (frame.method !== "tools/call" || params.name !== tool.name) {
    return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
  }
  try {
    // `caller()` is the library's own reader of the hub's `_meta` assertion (§7) — the
    // affordance an app author would use, exercised here on the live wire.
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

// ── the held stream (§21) ─────────────────────────────────────────────────────────────

/**
 * SSE blocks off a body this walk does NOT consume whole — the one response here that is
 * still being written while it is read. Blocks are separated by a blank line; a `:` line is
 * §21.1's keepalive comment and a `data:` line is a frame. `next` can discard preceding
 * blocks until its predicate accepts one, which keeps the helper usable for either form
 * without ever awaiting the entire response.
 */
function sseBlocks(body: ReadableStream<Uint8Array>): {
  next(budgetMs: number, want?: (block: string) => boolean): Promise<string>;
  close(): Promise<void>;
} {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const parsed: string[] = [];
  return {
    async next(budgetMs, want = () => true) {
      const stopAt = Date.now() + budgetMs;
      for (;;) {
        while (parsed.length > 0) {
          const block = parsed.shift() as string;
          if (want(block)) return block;
        }
        const remaining = stopAt - Date.now();
        if (remaining <= 0) throw new Error(`the stream delivered no matching block within ${budgetMs} ms`);
        const chunk = await deadline(reader.read(), remaining, "the stream delivered no matching block");
        if (chunk.done) throw new Error("the stream ended before the block arrived");
        buffered += decoder.decode(chunk.value, { stream: true });
        const blocks = buffered.split("\n\n");
        // The trailing element is whatever the terminator has not arrived for yet.
        buffered = blocks.pop() ?? "";
        for (const block of blocks) if (block.trim() !== "") parsed.push(block.trim());
      }
    },
    // Cancelling the READER is what tells the hub nobody is reading: the held response ends
    // on its next write, and the stream's subscriptions die with it (§21.1).
    close: () => reader.cancel().catch(() => {}),
  };
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

// ── §19: the OAuth walk's own small readers (no HTML parser dependency, §4) ────────────

/**
 * One hidden `<input>`'s value off rendered HTML, by name — consent.tsx renders
 * `<input type="hidden" name="…" value="…" />` in that order, and only ECHOES its two
 * fields (csrf, oauth_query) rather than rebuilding them. Hono JSX escapes attribute values
 * as HTML, so the raw match is entity-decoded before use.
 */
function hiddenField(html: string, name: string): string {
  const match = new RegExp(`name="${name}" value="([^"]*)"`).exec(html);
  if (match === null) throw new Error(`no hidden field named ${name} on the consent page`);
  return match[1]
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Bytes to the base64url this walk's PKCE verifier/challenge and state are spelled in. */
function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** §7/§19.6's own predicate for "JWT-shaped" — exactly three non-empty base64url segments —
 *  mirrored here as a sanity check on what the token endpoint minted, not a re-test of the
 *  door's dispatch (auth-matrix.test.ts owns that). */
function jwtShaped(token: string): boolean {
  const segments = token.split(".");
  return segments.length === 3 && segments.every((segment) => segment !== "" && /^[A-Za-z0-9_-]+$/.test(segment));
}

/** A JWT's payload segment, decoded and parsed — no signature check: the walk reads `aud`
 *  off a token it just minted from its own deployment, not one it must not trust. */
function jwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
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
