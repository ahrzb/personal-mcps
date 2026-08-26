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

import { createHash, randomBytes } from "node:crypto";
import { applyProfile, main as cli } from "../cli/src/main.ts";
import { caller, HubTransport } from "../clients/js/src/index.ts";

// ── the walk ──────────────────────────────────────────────────────────────────────────

applyProfile(process.argv.slice(2)); // fills PMCP_URL / BOOTSTRAP_SECRET where the env hasn't spoken
const ORIGIN = ((process.env.HUB_ORIGIN ?? "") !== "" ? required("HUB_ORIGIN") : required("PMCP_URL")).replace(/\/+$/, "");
const SECRET = required("BOOTSTRAP_SECRET");
const USERNAME = `smoke-${Date.now()}`;
const ACCOUNT = "smoke-agent";
const SERVICE = "smoke-svc";
const ROLE = "reader";
const TOOL = "echo";
/** The RFC 8628 client id cli/src/main.ts presents — the same string, on purpose. */
const DEVICE_CLIENT_ID = "pmcp-cli";
/** §19's throwaway OAuth client's one redirect URI — never actually dereferenced (the walk
 *  reads the code off the Location header with `redirect: "manual"`), so it only has to be a
 *  well-formed, non-loopback https URL, which is what a "web" DCR client's redirect must be
 *  (§19.3). `.invalid` is RFC 2606's reserved never-resolves TLD. */
const OAUTH_REDIRECT_URI = "https://smoke.invalid/callback";
/** The service account §19's OAuth binding is made to — its OWN, separate from `ACCOUNT`,
 *  so the scoped call below is never coupled to the approval-mode grant the main flow
 *  leaves on `ACCOUNT` by the time this step runs. */
const OAUTH_ACCOUNT = "smoke-oauth-agent";
/** The one call the walk makes through the tunnel. Reused verbatim on the approval retry —
 *  §7 binds an approval to the canonical JSON of `arguments`, so the retry must be
 *  byte-identical to match the row. */
const CALL_ARGS = { text: "smoke" } as const;

async function main(): Promise<number> {
  let password = "";
  let session = "";
  /** The same session as `session`, in the carrier the §13 pages accept: a signed cookie. */
  let sessionCookie = "";
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

    await step("§13 · the /services page renders for the browser session, and for nobody else", async () => {
      // The one page leg. The walk already holds the cookie the same sign-in set, so this
      // asks the deployment the question no MCP call can: does the browser surface render
      // at all — templates, stylesheet link, ops-backed reads — behind the cookie gate.
      const rendered = await fetch(`${ORIGIN}/services`, { headers: { Cookie: sessionCookie } });
      expect(rendered.status === 200, `authenticated /services → ${rendered.status}`);
      const html = await rendered.text();
      // A marker only the RENDERED page carries: the service the walk just created, drawn
      // in the table by the same read the `pmcp` tools front.
      expect(html.includes(SERVICE), `/services rendered no row for ${SERVICE}`);
      const anonymous = await fetch(`${ORIGIN}/services`, { redirect: "manual" });
      expect(
        anonymous.status === 302 && (anonymous.headers.get("location") ?? "").startsWith("/login"),
        `unauthenticated /services → ${anonymous.status} ${anonymous.headers.get("location") ?? ""}`,
      );
      return `200 with ${SERVICE} in the table; no cookie → ${anonymous.status} ${anonymous.headers.get("location") ?? ""}`;
    });

    await step("audit_query sees the calls", async () => {
      const rows = asArray((await owner("audit_query", { service: SERVICE })).rows);
      const calls = rows.filter((row) => asRecord(row, "audit row").event === "tools/call");
      expect(calls.length >= 2, `only ${calls.length} tools/call rows`);
      const events = rows.map((row) => String(asRecord(row, "audit row").event));
      return `${rows.length} rows for ${SERVICE}, ${calls.length} tools/call — ${JSON.stringify(unique(events))}`;
    });

    await step(
      "SMOKE · §19 · the full OAuth round-trip mints a JWT that reaches tools/call as sa:<slug> on both endpoint shapes, and revoking it stops the next call",
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
        const loginLocation = anonymousAuthorize.headers.get("location") ?? "";
        expect(
          anonymousAuthorize.status >= 300 && anonymousAuthorize.status < 400 && loginLocation.includes("/login"),
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
        const backToAuthorize = signedIn.headers.get("location") ?? "";
        expect(
          signedIn.status >= 300 && signedIn.status < 400 && backToAuthorize.includes("/oauth2/authorize"),
          `login POST → ${signedIn.status} ${backToAuthorize}`,
        );

        // Back at `authorize`, now WITH the fresh session and no covering consent — §19.5
        // step 2, the provider re-running the SAME signed query it built at step 1.
        const toConsent = await fetch(new URL(backToAuthorize, ORIGIN).toString(), {
          redirect: "manual",
          headers: { Cookie: browserCookie },
        });
        const consentLocation = toConsent.headers.get("location") ?? "";
        expect(
          toConsent.status >= 300 && toConsent.status < 400 && consentLocation.includes("/oauth/consent"),
          `authorize (signed in) → ${toConsent.status} ${consentLocation}`,
        );

        // The consent page itself: its own CSRF token, and the oauth_query it can only
        // echo — never invent, drop or edit (§19.5 step 2).
        const consentPageUrl = new URL(consentLocation, ORIGIN).toString();
        const consentHtml = await (await fetch(consentPageUrl, { headers: { Cookie: browserCookie } })).text();
        const csrf = hiddenField(consentHtml, "csrf");
        const oauthQuery = hiddenField(consentHtml, "oauth_query");

        // A service account THIS step creates and grants, so the scoped call below rides on
        // a grant this step controls — never on whatever approval state the main flow left
        // `ACCOUNT` in.
        await owner("account_create", { slug: OAUTH_ACCOUNT });
        await owner("grant_set", { account: OAUTH_ACCOUNT, service: SERVICE, roles: [ROLE] });

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
          body: new URLSearchParams({ csrf, oauth_query: oauthQuery, service_account: OAUTH_ACCOUNT, decision: "accept" }),
        });
        const codeLocation = consentPost.headers.get("location") ?? "";
        expect(
          consentPost.status >= 300 && consentPost.status < 400 && codeLocation.startsWith(OAUTH_REDIRECT_URI),
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
        // is not the one testing.
        const tokenAnswer = await postJson(`${ORIGIN}/api/auth/oauth2/token`, {
          grant_type: "authorization_code",
          code,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier,
          resource,
        });
        const accessToken = asString(tokenAnswer.access_token, "access_token");
        expect(jwtShaped(accessToken), "the minted access token is not JWT-shaped (§7/§19.6's own predicate)");
        const aud = jwtPayload(accessToken).aud;
        const audValues = Array.isArray(aud) ? aud : [aud];
        expect(audValues.includes(resource), `access token aud ${JSON.stringify(aud)}`);

        // The aggregated endpoint, and the SAME token scoped to the tunneled service — the
        // audience is namespace-wide (§19.6 step 3), so both endpoint shapes accept it.
        const aggregate = asRecord(await mcp(`${ORIGIN}/${USERNAME}/mcp`, accessToken, "tools/list"), "tools/list result");
        const aggregateNames = asArray(aggregate.tools).map((tool) => String(asRecord(tool, "catalog entry").name));
        expect(aggregateNames.includes(`${SERVICE}_${TOOL}`), `aggregated tools/list ${JSON.stringify(aggregateNames)}`);
        const scoped = asRecord(
          await mcp(`${ORIGIN}/${USERNAME}/mcp/${SERVICE}`, accessToken, "tools/call", {
            name: TOOL,
            arguments: CALL_ARGS,
          }),
          "scoped tools/call result",
        );
        const structured = asRecord(scoped.structuredContent, "structuredContent");
        expect(structured.principal === `sa:${OAUTH_ACCOUNT}`, `scoped call principal ${String(structured.principal)}`);

        // The audit trail names the bound ACCOUNT, never the client or the token (§19.6
        // step 5 — nothing downstream branches on how the credential arrived).
        const rows = asArray((await owner("audit_query", { principal: `sa:${OAUTH_ACCOUNT}` })).rows);
        const calls = rows.filter((row) => asRecord(row, "audit row").event === "tools/call");
        expect(calls.length > 0, `audit_query found no tools/call rows for sa:${OAUTH_ACCOUNT}`);

        // Revoke — immediate at the door (§19.6): the connection's next call gets the SAME
        // 401 challenge as no token at all.
        const connections = asArray((await owner("connection_list")).connections);
        const connection = connections.find(
          (row) => asRecord(row, "connection row").accountSlug === OAUTH_ACCOUNT,
        );
        if (connection === undefined) throw new Error(`connection_list carries no row for ${OAUTH_ACCOUNT}`);
        await owner("connection_revoke", { id: String(asRecord(connection, "connection row").id) });

        const refused = await fetch(`${ORIGIN}/${USERNAME}/mcp`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        });
        expect(refused.status === 401, `post-revoke call → ${refused.status}`);
        expect(
          (refused.headers.get("WWW-Authenticate") ?? "").includes("resource_metadata"),
          `post-revoke challenge: ${refused.headers.get("WWW-Authenticate") ?? ""}`,
        );

        return `client ${clientId} → aud ${resource}; aggregate+scoped tools/call both as sa:${OAUTH_ACCOUNT}; ${calls.length} audit row(s); revoked → 401 with challenge`;
      },
    );
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
  // Every cookie the sign-in set, sent back together — what a browser does, and the only
  // rule here that needs no knowledge of better-auth's cookie NAMES (which carry a
  // `__Secure-` prefix under https and may be more than one).
  const cookie = response.headers
    .getSetCookie()
    .map((header) => header.split(";")[0])
    .join("; ");
  if (cookie === "") throw new Error("sign-in set no session cookie");
  return { token, cookie };
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
