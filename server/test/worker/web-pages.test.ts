// web-pages.test.ts — the browser surface, kept thin on purpose. §13's pages carry no
// business logic, so this suite deliberately pins only what is TRUE OF THE PAGES and false
// nowhere else: the CSRF gate (with the ops handler provably not run — a 403 that still
// mutated is the failure this file exists to catch), cookie-session-only access with
// `/approvals/<id>` owner-only, the JSONL export's line count equal to `audit_query`'s
// `total`, parity
// DIRECTION B: every mutating form's fields are exactly the fronted op's schema keys — and
// §4's recent-auth gate on /settings's credential MUTATIONS, not merely on its read.
//
// SINCE 2026-09-21 (decision 36) `/audit` is a THIRD SPA family, so the four describes that
// walked its table, its filter row, its expanded row and its scan ceiling are gone with the
// page they pinned — the same trade the eleven `/apps`/`/agents` describes made below. What
// stands in their place is the boundary: the shell on `/audit`, the two `/api/hub` audit
// reads, and the export route (which was never the page's and keeps its own describe).
//
// SINCE 2026-09-23 (decision 38) every page moves into the client, one family per ship, and
// a row that pinned a check on a page is PORTED to the route that replaces it rather than
// deleted (`docs/superpowers/plans/2026-09-23-everything-spa-routes.md` names each row's
// fate). Family 1, `/approvals` and `/approvals/<id>`: both are the shell (row 8 keeps the
// document 404, 8b ports it to `GET /api/hub/approvals/<id>`), Approve/Reject is
// `approval_decide` through the ops allowlist (G52 and 19 ported), and the push opt-in is
// `POST /api/hub/approvals/push`; 16 and 17 retired, saying where their guarantees went.
//
// SINCE 2026-09-18, "the pages" means TWO surfaces and this file describes both.
// `/apps/*` and `/agents/*` are a browser SPA: they answer one shell document with a
// `#pmcp-bootstrap` JSON island and a module script, and every read and write they used to
// perform is a call to `/api/hub`. So the eleven describes that walked their markup are
// gone — they asserted about pages that render none — and what stands in their place is
// the BOUNDARY: the shell's gate order (session, then existence, then the document), its
// two assets, `/api/hub`'s four-barrier write gate with the op provably unreached at each
// barrier, the nine-name ops allowlist in both directions, and the five typed-route
// behaviours that are the reason those routes exist at all — a filtered save leaving
// undrawn literals alone chief among them. What the deleted describes proved about
// RENDERING is the React gallery's and the screenshot comparison's now; what they proved
// about ROUTING moved to routes.test.ts, which owns the retained 301s.
//
// Two more, both because a form nobody submits is a contract nobody checked (§9 rule 4b):
// /device's approve/deny form is POSTED, as a browser posts it, through the whole RFC 8628
// flow to the CLI's redemption; and the two §15 auth events a page can cause — `auth.login`
// and `auth.device_approved` — are read back out of the audit store and held to §15's
// hygiene. The ledger is read through audit.query, never off the table.
//
// Direction B is derived on BOTH sides, which is why this file exports no row table and
// declares none: one side is walked out of the rendered HTML, the other read off
// admin.ops[name].schema. A transcribed form→field list would be a third copy of the
// truth, and maintaining it is precisely the drift Direction B exists to catch. Its
// `/apps` half is now the ops allowlist walk, derived the same way — what the router
// admits, measured, never a list copied out of api.ts.
// (`pageRoutes`-as-data was considered and rejected for the same reason — exporting the
// route table solely for a test violates the suite's no-test-only-exports rule; Direction
// B plus review is the guard.)
//
// Project: `worker` — real D1, real better-auth sessions, no sockets; pages are driven
// through `exports.default.fetch`, never by calling web.ts internals (csrfTokenFor,
// checkCsrf, streamAuditJsonl and upstreamCallbackShell are unexported by design, and a
// test that reached past `pageRoutes` would pin the module's private business).
//
// Isolation, load-bearing: proving "the handler never ran" means substituting a counting
// handler into the exported `admin.ops` table for the length of one case and restoring it
// there. Per-file storage and module isolation is what keeps a leaked substitution inside
// this file; no case may depend on a substitution another case made.
//
// Not pinned here, on purpose: every page's HTML (§7 — all HTML is incidental). Assertions
// name form fields, row counts, and status codes; never markup, copy, or layout. One named
// exception: §13's icon links, where the `rel` token IS the browser contract and not
// presentation — and even there the href stays `paths.icon192`, never a literal.

// deps: harness/seed · src/index (exports.default.fetch) · src/admin (ops — one handler substituted to prove non-execution) · src/audit · src/approvals · src/identity (session minting) · src/principal (tokenPattern) · applyD1Migrations

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ops } from "../../src/admin";
import type { AdminOp, AppRow as OpsAppRow } from "../../src/admin";
import { AGENT_PANES, APP_PANES } from "../../src/app-routes";
import { Approvals } from "../../src/approvals";
import { query, record } from "../../src/audit";
import type { AuditQuery, AuditRow } from "../../src/audit";
import {
  AUTH_BASE_PATH,
  PASSWORD_MIN_LENGTH,
  requireOwnerSession,
  resolveAppToken,
  stampPasskeyUse,
} from "../../src/identity";
import type { TokenInfo } from "../../src/identity";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import {
  AUDIT_ARGS_HEAD_CHARS,
  AUDIT_EXPLORER_PAGE,
  AUDIT_EXPLORER_ROWS,
  AUDIT_EXPORT_MAX_VALUES,
  HUB_HARD_MAX_TIMEOUT_MS,
  HUB_MIN_TIMEOUT_MS,
  RETENTION_DAYS,
} from "../../src/limits";
import { generatedAlias } from "../../src/hub-types";
import { paths, SETTINGS_CONFIRM_PANE } from "../../src/pages/model";
// The SPA's own path table, compared against the worker's: the two are separate modules, and
// a React form posting to a route the worker does not translate is invisible to any test that
// reads server HTML (24a).
import { paths as webPaths } from "../../../web/src/lib/paths";
import type { ConnectionRow, SettingsConfirm } from "../../src/pages/model";
import { tokenPattern } from "../../src/principal";
import { PMCP_SLUG, Registry, validateSchemaIndirection } from "../../src/registry";
import type { App, RoleDeclaration } from "../../src/registry";
import { beginConnect } from "../../src/upstream";
import { AS_HOST, upstreamUrlFor } from "../harness/fake-upstream";
import type { AsScenario, UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerCredential, seedOwnerSession, SEEDED_OWNER_PASSWORD, uniqueSlug } from "../harness/seed";
import { totpCode } from "../harness/totp";
import type { SeededNamespace, SeededSession } from "../harness/seed";

/**
 * Direction B, side one: every mutating form a rendered page carries, as the ops key it
 * fronts plus the field names it submits. How a form DECLARES its op — action path, hidden
 * field, whatever web.ts chooses at implementation — is known only here, so Direction B
 * survives that choice being made or changed. A page with no mutating form yields [], which
 * is the correct answer for /audit and the required answer for /settings.
 *
 * What web.ts chose (pages/model's `paths` states it): the FINAL PATH SEGMENT of a
 * mutating target names the op, and the arguments that are not form controls ride the
 * target's query string under the op's own field names. So a form's field set is its named
 * controls (minus the CSRF token, which is the page layer's own business and no op's) plus
 * its query parameters. One <form> can carry more than one target — a submit button's
 * `formaction` is a target of its own — and each is reported separately, because each is a
 * different op with a different field set.
 */
export function formsRenderedOn(html: string): { op: string; fields: string[] }[] {
  // deps: HTMLRewriter (form/input/select/textarea walk)
  const found: { op: string; fields: string[] }[] = [];
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    const attributes = form[1];
    const body = form[2];
    if ((attributeOf(attributes, "method") ?? "get").toLowerCase() !== "post") continue;
    const controls = namedControls(body);
    const targets = new Set([attributeOf(attributes, "action") ?? "", ...formActions(body)]);
    for (const target of targets) {
      const url = new URL(decodeEntities(target), "https://pages.invalid");
      found.push({
        op: url.pathname.split("/").filter(Boolean).pop() ?? "",
        fields: [...new Set([...controls, ...[...url.searchParams.keys()]])].sort(),
      });
    }
  }
  return found;
}

/**
 * Direction B, side two: the input field names an op accepts, read off its single source of
 * input truth (the field declaration that also renders the MCP inputSchema — admin.ts owns
 * its shape; this reads the keys and nothing else). Nothing between the two sides is
 * hand-maintained — that is the whole point of the direction.
 */
export function schemaKeysOf(op: AdminOp): string[] {
  // deps: admin.AdminOp.schema
  const fields = (op.schema as { fields: Record<string, unknown> }).fields;
  return Object.keys(fields).sort();
}

/** One attribute's value out of a start tag — quoted, as every renderer emits them. */
function attributeOf(attributes: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attributes)?.[1] ?? null;
}

/** The `name`s of the controls inside one form, minus the CSRF token. */
function namedControls(body: string): string[] {
  const names = new Set<string>();
  for (const control of body.matchAll(/<(?:input|select|textarea|button)\b([^>]*)>/g)) {
    const name = attributeOf(control[1], "name");
    if (name !== null && name !== "csrf") names.add(name);
  }
  return [...names];
}

/** A submit button's own target — one <form>, two ops (Archive beside Disconnect). */
function formActions(body: string): string[] {
  const actions: string[] = [];
  for (const control of body.matchAll(/<button\b([^>]*)>/g)) {
    const action = attributeOf(control[1], "formaction");
    if (action !== null) actions.push(action);
  }
  return actions;
}

/** The renderer escapes `&` in attribute values; a URL comes back through this. */
function decodeEntities(value: string): string {
  return value.replace(/&amp;/g, "&");
}

/* ------------------------------------------------------------------ *
 * The seeded world
 * ------------------------------------------------------------------ */

const ORIGIN = (env as unknown as Env).PUBLIC_ORIGIN;

/** The RFC 8628 client id the CLI presents — the same string /device sees. */
const DEVICE_CLIENT_ID = "pmcp-cli";

/** How many audit rows the window, record and export cases are written against. */
const SEEDED_EVENTS = 9;

/** The tool name every seeded audit row carries a numbered variant of, so a row is
 *  identifiable in rendered HTML and in an exported line by the same string. */
const TOOL_PREFIX = "walk-tool-";

/** The client session id half the seeded rows share (§13's ?session=… link). */
const SHARED_SESSION = "sess-walk-shared";

type World = {
  ns: SeededNamespace;
  /** The owner's browser session, and a SECOND one for the cross-session CSRF row. */
  session: SeededSession;
  other: SeededSession;
  sessionId: string;
  /** A device-flow session: a real bearer, and deliberately no cookie of its own. */
  deviceToken: string;
  /** A pending approval in this namespace, and one in a foreign namespace. */
  approvalId: string;
  foreign: { ns: SeededNamespace; approvalId: string };
  /** The oauth-mode proxied app the callback case connects. */
  oauth: { app: App; scenario: UpstreamScenario };
};

let world: World;

beforeAll(async () => {
  const scenario: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    as: { id: uniqueSlug("as") } as AsScenario,
  };
  const ns = await seedNamespace(env.DB, {
    apps: [
      { slug: "news", kind: "tunnel", tokens: [{ as: "news" }] },
      { slug: "parked", kind: "tunnel", archived: true },
      {
        slug: "notion",
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "oauth",
      },
    ],
    agents: [
      {
        slug: "agent",
        grants: { news: [{ role: "all", mode: "approval" }] },
        tokens: [{ as: "agent" }],
      },
    ],
  });
  const session = await seedOwnerSession(ns.owner);
  const other = await seedOwnerSession(ns.owner);
  const { sessionId } = await requireOwnerSession(
    new Request(`${ORIGIN}${paths.apps}`, { headers: { Cookie: session.cookie } }),
  );
  const app = await new Registry(env.DB).getApp(ns.owner.userId, "notion");
  if (app === null) throw new Error("web-pages: the seeded oauth app vanished");

  await seedAuditRows(ns.owner.userId);

  world = {
    ns,
    session,
    other,
    sessionId,
    deviceToken: await deviceFlowToken(session.cookie),
    approvalId: await openApproval(ns, "news"),
    foreign: await foreignWorld(),
    oauth: { app, scenario },
  };
});

/** A namespace that is not the fixture owner's, with a pending approval of its own —
 *  the only way to ask "does /approvals/<id> refuse someone else's id" honestly. */
async function foreignWorld(): Promise<World["foreign"]> {
  const ns = await seedNamespace(env.DB, {
    apps: [{ slug: "news", kind: "tunnel" }],
    agents: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] } }],
  });
  return { ns, approvalId: await openApproval(ns, "news") };
}

/**
 * One pending approval, opened the only way one is ever opened: a gated call through
 * `Approvals.check`. Nothing here writes an approval row by hand — a fixture that did
 * would be pinning a shape rather than a behavior.
 */
async function openApproval(ns: SeededNamespace, slug: string): Promise<string> {
  const app = await new Registry(env.DB).getApp(ns.owner.userId, slug);
  if (app === null) throw new Error(`openApproval: no app "${slug}"`);
  const approvals = new Approvals({
    db: env.DB,
    publicOrigin: ORIGIN,
    audit: { record: (entry) => record(env.DB, entry) },
    retentionDays: 7,
    now: Date.now,
  });
  const checked = await approvals.check(
    { kind: "agent", agentId: ns.agents.agent.id, ownerId: ns.owner.userId, slug: "agent" },
    app,
    "search",
    { q: "term" },
    [],
  );
  return checked.approvalId;
}

/**
 * The audit rows every audit case reads. Written through `audit.record` —
 * the one write path — so what the two reads and the export answer with is what the hub
 * actually stores, bodies and stubs included (§15).
 */
async function seedAuditRows(ownerId: string): Promise<void> {
  for (let at = 0; at < SEEDED_EVENTS; at++) {
    await record(env.DB, {
      ownerId,
      principal: "agent:agent",
      event: "tools/call",
      app: "news",
      tool: `${TOOL_PREFIX}${at}`,
      outcome: at === 0 ? "-32001" : "ok",
      durationMs: 10 + at,
      // Half the rows share one client session, which is what the ?session=… link
      // narrows to.
      client: { name: "walker", version: "1.0", sessionId: at % 2 === 0 ? SHARED_SESSION : `sess-${at}` },
      // Post-redaction bodies, because that is the only form the hub ever stores: the
      // masked argument, and a result carrying one whole-body stub.
      args: { q: "term", token: "‹redacted›" },
      result: { content: [{ stub: "blob", contentType: "image/png", bytes: 4_200_000 }] },
    });
  }
}

/**
 * The RFC 8628 exchange, driven through the same better-auth endpoints the CLI uses. What
 * comes back is a session token and NO cookie — which is exactly why a device-flow session
 * cannot be presented as a browser session (§4).
 */
async function deviceFlowToken(ownerCookie: string): Promise<string> {
  const asOwner = { "content-type": "application/json", origin: ORIGIN, cookie: ownerCookie };
  const codes = await requestDeviceCodes();
  await call(new Request(`${ORIGIN}/api/auth/device?user_code=${codes.userCode}`, { headers: asOwner }));
  await call(
    new Request(`${ORIGIN}/api/auth/device/approve`, {
      method: "POST",
      headers: asOwner,
      body: JSON.stringify({ userCode: codes.userCode }),
    }),
  );
  const redeemed = await redeemDeviceCode(codes.deviceCode);
  // The error names the refusal, never the body: a redemption's body is a session token
  // when it works, and a failure message is not the place to find out (§15).
  if (!redeemed.access_token) throw new Error(`device token failed: ${redeemed.error ?? "no token"}`);
  return redeemed.access_token;
}

/**
 * One fresh device-flow request, as the CLI makes it: better-auth issues the PAIR, and both
 * halves are needed to walk the flow — the user code is what the owner types into /device,
 * the device code is what the CLI redeems afterwards. Unclaimed until a signed-in browser
 * verifies the user code, which is why /device's own render is a step of the flow and not
 * merely a page (better-auth refuses approve and deny alike on an unclaimed code).
 */
async function requestDeviceCodes(): Promise<{ deviceCode: string; userCode: string }> {
  const requested = (await (
    await call(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
      }),
    )
  ).json()) as { device_code: string; user_code: string };
  return { deviceCode: requested.device_code, userCode: requested.user_code };
}

/**
 * The CLI's half of RFC 8628, which is where a device decision becomes observable: an
 * approved code redeems to a session token, a denied one to `access_denied` and nothing
 * else. The whole answer is handed back rather than asserted here, because "what came back"
 * is exactly what the approve and deny cases differ on.
 */
async function redeemDeviceCode(deviceCode: string): Promise<{ access_token?: string; error?: string }> {
  const redeemed = await call(
    new Request(`${ORIGIN}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: DEVICE_CLIENT_ID,
      }),
    }),
  );
  return (await redeemed.json().catch(() => ({}))) as { access_token?: string; error?: string };
}

/* ------------------------------------------------------------------ *
 * Driving the pages
 * ------------------------------------------------------------------ */

/** Every request in this file goes through the composition root, exactly as a browser's would. */
function call(request: Request): Promise<Response> {
  return worker.fetch(request, env as unknown as Env);
}

/** One page, fetched as the signed-in owner. */
function get(path: string, cookie: string = world.session.cookie): Promise<Response> {
  return call(new Request(`${ORIGIN}${path}`, { headers: { Cookie: cookie } }));
}

/** One page's HTML, which is only ever WALKED — never asserted on (§7). */
async function page(path: string, cookie?: string): Promise<string> {
  const response = await get(path, cookie);
  expect(response.status, `GET ${path}`).toBe(200);
  return response.text();
}

/** The CSRF token a page rendered — the only place a test may get one, because it is the
 *  only place a browser gets one. */
function csrfOf(html: string): string {
  const token = /name="csrf"\s+value="([^"]+)"/.exec(html)?.[1];
  if (token === undefined) throw new Error("the page rendered no CSRF field");
  return token;
}

/**
 * The CSRF token a SHELL document bootstrapped — the other half of `csrfOf`, and the only
 * place a browser on an SPA route gets one. `/apps/*` and `/agents/*` render no form at
 * all since 2026-09-18: the session's token rides a `<script type="application/json"
 * id="pmcp-bootstrap">` island that the client parses on mount.
 *
 * Parsed with `JSON.parse`, not scraped with a second regex, because that is what the
 * client does: a token this helper could read but the island's JSON could not carry is a
 * token no browser can use, and the difference is exactly the escaping bug the island's
 * `raw()` exists around.
 */
function bootstrapCsrfOf(html: string): string {
  const csrf = bootstrapOf(html).csrf;
  if (typeof csrf !== "string") throw new Error("the bootstrap island carried no csrf");
  return csrf;
}

/** The whole `#pmcp-bootstrap` island, parsed as the client parses it — for the rows that
 *  pin its field set rather than one field. */
function bootstrapOf(html: string): Record<string, unknown> {
  const island = /<script type="application\/json" id="pmcp-bootstrap">([\s\S]*?)<\/script>/.exec(html);
  if (island === null) throw new Error("the document carried no #pmcp-bootstrap island");
  const parsed: unknown = JSON.parse(island[1]);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the bootstrap island is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * One `/api/hub` call, shaped the way the browser client shapes it: the session cookie,
 * a JSON body, and the `X-Pmcp-Csrf` header the write gate reads. Every option is absent
 * by omission rather than by a flag, because each absence is a real shape — no header is
 * the cross-site fetch, `cookie: null` is the signed-out one, and a foreign `Origin` is
 * the cross-site page. `body` is passed through when it is a string, so a case can send
 * something that is not an object at all.
 */
function hub(
  method: string,
  path: string,
  body?: unknown,
  options: { cookie?: string | null; csrf?: string; origin?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const cookie = options.cookie === undefined ? world.session.cookie : options.cookie;
  if (cookie !== null) headers.Cookie = cookie;
  if (options.csrf !== undefined) headers["X-Pmcp-Csrf"] = options.csrf;
  if (options.origin !== undefined) headers.Origin = options.origin;
  return call(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    }),
  );
}

/** One `/api/hub` answer as the object every one of them is. Checked once here rather
 *  than asserted inline at each read: an answer that is not an object is a bug in the
 *  surface, and a case reading a field off it would otherwise report the wrong failure. */
async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error(`the answer was not a JSON object: ${JSON.stringify(body)}`);
  }
  // Narrowed above; `object` has no index signature, and this is the one place that is
  // turned into a readable record.
  return body as Record<string, unknown>;
}

/** The `reason` every refusal carries (§15's refusals name fields, never values). */
async function reasonOf(response: Response): Promise<string> {
  const reason = (await jsonOf(response)).reason;
  return typeof reason === "string" ? reason : "";
}

/** One mutating POST, as the browser's form makes it. `csrf` absent means the field is
 *  simply not submitted — the shape of a cross-site post. */
function post(
  target: string,
  fields: Record<string, string>,
  options: { cookie?: string; csrf?: string } = {},
): Promise<Response> {
  const body = new FormData();
  if (options.csrf !== undefined) body.set("csrf", options.csrf);
  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  return call(
    new Request(`${ORIGIN}${target}`, {
      method: "POST",
      headers: { Cookie: options.cookie ?? world.session.cookie },
      body,
    }),
  );
}

/**
 * One form as a BROWSER submits it: `application/x-www-form-urlencoded`, which is exactly
 * the content type better-auth's router refuses (its endpoints allow `application/json`
 * only). `post` above sends multipart FormData and is refused the same way, so the two
 * helpers are not interchangeable — this one is what the credential cases are about.
 */
function formPost(
  target: string,
  fields: Record<string, string> | [string, string][],
  cookie?: string,
): Promise<Response> {
  return call(
    new Request(`${ORIGIN}${target}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // A same-site form post carries one, and the credential routes have their own
        // origin rule (they stand outside the CSRF gate — /login has no session yet).
        Origin: ORIGIN,
        ...(cookie === undefined ? {} : { Cookie: cookie }),
      },
      body: new URLSearchParams(fields).toString(),
    }),
  );
}

/** One page fetched with NO cookie at all — the state a human who cannot sign in is in. */
async function anonymousPage(path: string): Promise<string> {
  const response = await call(new Request(`${ORIGIN}${path}`));
  expect(response.status, `GET ${path}`).toBe(200);
  return response.text();
}

/**
 * The session cookie a response set, or null. Matched by the NAME better-auth chose rather
 * than a spelled one (the `__Secure-` prefix depends on the origin), read off the fixture's
 * own cookie; a cleared cookie (`name=`) is not a session and answers null.
 */
function sessionCookieOf(response: Response): string | null {
  const name = world.session.cookie.split("=")[0];
  return (
    response.headers
      .getSetCookie()
      .map((header) => header.split(";")[0])
      .find((pair) => pair.startsWith(`${name}=`) && pair.length > name.length + 1) ?? null
  );
}

/**
 * One rendered form as a browser would submit it untouched: every named control under the
 * value the page put there — hidden fields carry real ones (the CSRF token, the redirect
 * target, a row id) and typed fields carry "".
 *
 * A CHECKBOX is the exception a browser makes and this has to make too: an unticked box
 * contributes nothing at all to the body, and a ticked one contributes its `value` (or
 * `on`). Without that, the Password pane's default-on flag would be indistinguishable
 * from an unticked one, and "posted as the browser posts it" would be false.
 */
function submissionOf(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const control of body.matchAll(/<input\b([^>]*)>/g)) {
    const name = attributeOf(control[1], "name");
    if (name === null) continue;
    const value = decodeEntities(attributeOf(control[1], "value") ?? "");
    if (attributeOf(control[1], "type") === "checkbox") {
      if (/\bchecked\b/.test(control[1])) fields[name] = value === "" ? "on" : value;
      continue;
    }
    fields[name] = value;
  }
  return fields;
}

/**
 * Every form on a page that posts to `target`, as the controls it rendered. PLURAL because
 * a card the page draws twice — the wide row and the narrow stack are two real forms — is
 * two submissions a browser can make, and a control missing from either is a click that
 * cannot work.
 */
function formsPostingTo(html: string, target: string): Record<string, string>[] {
  const found: Record<string, string>[] = [];
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if (decodeEntities(attributeOf(form[1], "action") ?? "") !== target) continue;
    found.push(submissionOf(form[2]));
  }
  return found;
}

/**
 * One rendered form, filled the way a human fills it: a value typed into a control THE PAGE
 * DREW. A field the page renders no control for is a field no browser can send however the
 * server-side seam reads it, so the assertion is here rather than in the case — filling a
 * name the form never carried is the exact bug this refuses to paper over (§9 rule 4b).
 */
function typedInto(
  form: Record<string, string>,
  typed: Record<string, string>,
): Record<string, string> {
  for (const name of Object.keys(typed)) {
    expect(Object.keys(form), `the rendered form carries no "${name}" control`).toContain(name);
  }
  return { ...form, ...typed };
}

/**
 * One rendered form the instant a particular submit BUTTON is clicked: the action the page
 * named, and every control that submission carries — the hidden ones `submissionOf` walks
 * plus the clicked button's own name/value. A submit button is a form control like any
 * other, and on /device's decision form it is the only place the decision is written
 * (device.tsx draws Approve and Deny as two buttons on one form), so a submission walked out
 * of the <input>s alone would post no decision at all and the case would prove nothing.
 * Throws rather than returning null: a page that renders no such button is a page whose
 * form the walk can no longer describe.
 */
function clickedSubmission(
  html: string,
  value: string,
): { action: string; fields: Record<string, string> } {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
    for (const button of form[2].matchAll(/<button\b([^>]*)>/g)) {
      const name = attributeOf(button[1], "name");
      if (name === null || attributeOf(button[1], "value") !== value) continue;
      return {
        action: decodeEntities(attributeOf(form[1], "action") ?? ""),
        fields: { ...submissionOf(form[2]), [name]: value },
      };
    }
  }
  throw new Error(`the page rendered no posting form with a submit button valued "${value}"`);
}

/**
 * Age one browser session past better-auth's freshness window — the passage of time, and
 * the one state no seam can express (requireOwnerSession takes no clock, and a production
 * affordance for "make this session old" is precisely what must not exist). The column is
 * better-auth's own and holds ISO-8601 text, since its SQLite adapter stores dates as
 * strings, so the write speaks that.
 */
async function ageSession(token: string, by: number = AGED_SESSION_MS): Promise<void> {
  await (env.DB as D1Like)
    .prepare(`UPDATE "session" SET "createdAt" = ? WHERE "token" = ?`)
    .bind(new Date(Date.now() - by).toISOString(), token)
    .run();
}

/** Comfortably past better-auth's one-day `freshAge`, and nowhere near session expiry. */
const AGED_SESSION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Make one owner's second factor LIVE. No hub route can: /settings never renders the
 * mid-enrollment card (model.ts's `settingsProps` says why), so the verify step that flips
 * this column in production needs a code derived from a secret no page ever shows. The
 * column is better-auth's own, and the row it makes live is the one the rendered enable
 * form just created — everything asserted after it still goes through that page's own form
 * and the real route.
 */
async function enrollTwoFactor(userId: string): Promise<void> {
  await (env.DB as D1Like)
    .prepare(`UPDATE "user" SET "twoFactorEnabled" = 1 WHERE "id" = ?`)
    .bind(userId)
    .run();
}

/** The same column, read — the postcondition a refused verify has to leave behind, and the
 *  one thing no rendered page says (settingsProps reports the summary, not the flag). */
async function twoFactorEnabledOf(userId: string): Promise<number> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "twoFactorEnabled" AS enabled FROM "user" WHERE "id" = ?`)
    .bind(userId)
    .first<{ enabled: number | null }>();
  return row?.enabled ?? 0;
}

/** Obviously fake, and never the seeded password: what a credential POST carries when the
 *  case is about the SESSION rather than about the secret. */
const WRONG_PASSWORD = "FAKE0000-not-the-seeded-password";

/**
 * A password of EXACTLY `length` characters, obviously fake. Boundary rows spell a length
 * and never a password, so `PASSWORD_MIN_LENGTH - 1` and `PASSWORD_MIN_LENGTH` are one
 * expression apart and no literal secret is transcribed into a case. Two different lengths
 * are two different strings, which is what lets a row say "and refuses BOTH candidates".
 */
function fakePassword(length: number): string {
  return "FAKE0000-".padEnd(length, "x").slice(0, length);
}

/**
 * The Password pane and the submission a browser would send from its form untouched — the
 * page's real CSRF token and the default-on checkbox riding exactly as drawn. Every
 * change-password row starts here, because a submission assembled any other way is not
 * the one the page rendered.
 */
async function passwordForm(
  cookie: string,
): Promise<{ pane: string; form: Record<string, string> }> {
  const pane = await page(paths.settings, cookie);
  const forms = formsPostingTo(pane, paths.auth.changePassword);
  expect(forms.length, "the Password pane rendered no change-password form").toBeGreaterThan(0);
  return { pane, form: forms[0] };
}

/**
 * One owner holding THREE live sessions — two browsers and one the device flow minted for
 * the CLI, which is §13's "every CLI session is among the others" made countable. The two
 * halves of the checkbox journey build their world through this one helper so the only
 * difference between them is the submission itself.
 */
async function threeSessions(ns: SeededNamespace): Promise<{
  actor: SeededSession;
  bystander: SeededSession;
  device: string;
  before: string;
  otherId: string;
}> {
  const actor = await seedOwnerSession(ns.owner);
  const bystander = await seedOwnerSession(ns.owner);
  const device = await deviceFlowToken(actor.cookie);
  expect((await whoami(device)).status, "the device session never came up").toBe(200);
  return {
    actor,
    bystander,
    device,
    before: await sessionIdOf(actor.cookie),
    otherId: await sessionIdOf(bystander.cookie),
  };
}

/** The same submission with the checkbox key deleted — what a browser sends for an
 *  UNTICKED box, and the one difference between the flag's two journeys. */
function unticked(fields: Record<string, string>): Record<string, string> {
  const copy = { ...fields };
  delete copy.revokeOtherSessions;
  return copy;
}

/**
 * The two credential targets that END SESSIONS when they succeed — Sign out, and §13's
 * Revoke all others, which deletes every OTHER session of the owner posting it. Any walk
 * over the credential family has to run them last or it kills the sessions its remaining
 * legs are riding, which is a red row about the wrong thing.
 */
const ENDS_SESSIONS = (target: string): boolean =>
  target === paths.auth.signOut || target === paths.auth.revokeOtherSessions;

/** Every page that renders a credential form — /login's three cards, the signed-in shell's
 *  Sign out, all seven settings panes, and the destructive confirm dialogs, which is where
 *  three of the credential forms exist at all (§13 puts them behind `?confirm=`). */
async function credentialPages(cookie: string): Promise<string[]> {
  const rendered = [
    await anonymousPage(paths.login),
    await anonymousPage(`${paths.login}?step=totp`),
    await anonymousPage(`${paths.login}?step=backup-code`),
    await page(paths.apps, cookie),
  ];
  for (const pane of PANES) rendered.push(await page(pane, cookie));
  rendered.push(await page(paths.settingsConfirm("two-factor", "disable-two-factor"), cookie));
  rendered.push(await page(paths.settingsConfirm("sessions", "revoke-other-sessions"), cookie));
  return rendered;
}

/**
 * The `?confirm=` link a pane rendered for one row, or null when it rendered none. Both
 * sides are built from `paths` and `SETTINGS_CONFIRM_PANE`, so the page and the walk
 * cannot spell the URL differently and a dialog kind cannot be looked for on a pane that
 * does not own it (§13's "mutations belong to a pane").
 */
function confirmLinkFor(
  html: string,
  kind: SettingsConfirm["kind"],
  id?: string,
): string | null {
  const link = paths.settingsConfirm(SETTINGS_CONFIRM_PANE[kind], kind, id);
  return html.includes(link.replace(/&/g, "&amp;")) ? link : null;
}

/** The Sessions pane's own spelling of the above — the seam the Revoke journey walks. */
function revokeLinkFor(html: string, sessionId: string): string | null {
  return confirmLinkFor(html, "revoke-session", sessionId);
}

/** Every `?confirm=` link one rendered pane carries, as the URLs a browser would follow. */
function confirmLinksOn(html: string): string[] {
  const found = new Set<string>();
  for (const anchor of html.matchAll(/<a\b[^>]*href="([^"]*confirm=[^"]*)"/g)) {
    found.add(decodeEntities(anchor[1]));
  }
  return [...found];
}

/**
 * The DISTINCT session ids the Sessions pane offered a Revoke for, read off the links it
 * actually drew. Derived through `confirmLinksOn` and the query the page emitted rather
 * than a hand-spelled `confirm=revoke-session&amp;id=…` regex, for the reason
 * `confirmLinkFor` exists: a change to `paths.settingsConfirm`'s query shape must fail
 * loudly here, not silently empty the set. Distinct ids because the sessions card renders
 * twice into one document (§13's two-column pane).
 */
function revocableIds(html: string): Set<string> {
  return new Set(
    confirmLinksOn(html)
      .map((href) => new URL(href, ORIGIN))
      .filter((url) => url.searchParams.get("confirm") === "revoke-session")
      .map((url) => url.searchParams.get("id") ?? ""),
  );
}

/** The session id behind a cookie — identity's own answer, the same one /settings badges. */
async function sessionIdOf(cookie: string): Promise<string> {
  const { sessionId } = await requireOwnerSession(
    new Request(`${ORIGIN}${paths.settings}`, { headers: { Cookie: cookie } }),
  );
  return sessionId;
}

/**
 * Substitutes counting handlers into the ops table for the length of one case and restores
 * them there — the mechanism the "was it invoked" cases rest on. The substitute records
 * its input and does NOTHING else, so a page that mutated D1 on its own would leave a
 * change nothing agents for (case 19).
 */
async function withCountedOps<T>(
  names: readonly string[],
  work: (invocations: Map<string, unknown[]>) => Promise<T>,
): Promise<T> {
  const original = new Map(names.map((name) => [name, ops[name]]));
  const invocations = new Map<string, unknown[]>();
  for (const name of names) {
    const real = original.get(name);
    if (real === undefined) throw new Error(`withCountedOps: no such op "${name}"`);
    ops[name] = {
      schema: real.schema,
      handler: async (_ownerId: string, input: unknown) => {
        invocations.set(name, [...(invocations.get(name) ?? []), input]);
        return {};
      },
    };
  }
  try {
    return await work(invocations);
  } finally {
    for (const [name, real] of original) if (real !== undefined) ops[name] = real;
  }
}

/** How many times a substituted op ran. */
const times = (invocations: Map<string, unknown[]>, name: string): number =>
  (invocations.get(name) ?? []).length;

/* ------------------------------------------------------------------ *
 * The cases
 * ------------------------------------------------------------------ */

describe("§13 · the bare root sends people where they can act", () => {
  // `/` names no segment, so it must not 404: a signed-in owner lands on their apps,
  // an anonymous visitor on sign-in. Both are 302s, driven through the real composition root.
  it("GET / with an owner cookie → 302 /apps", async () => {
    const response = await call(new Request(`${ORIGIN}/`, { headers: { Cookie: world.session.cookie } }));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/apps");
  });

  it("GET / with no session → 302 /login", async () => {
    const response = await call(new Request(`${ORIGIN}/`));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("§13 · CSRF on every mutating POST", () => {
  // Cases 1-3 moved from `POST /apps/app_archive` to `POST /api/hub/ops/app_archive` with
  // the SPA cutover (2026-09-18). The form target is gone; the property is not. The three
  // things they said about the form field are the three things they say about the header —
  // absent is refused, another session's is refused, the session's own passes — because
  // both carriers are compared against `csrfTokenFor(sessionId)` and nothing else. The
  // header is additionally a barrier of its own: a cross-site page cannot set it without a
  // preflight the hub never answers.
  it("1. §13 · a mutating POST with no CSRF header is 403 AND the substituted ops handler was never invoked (a rejected-but-executed mutation is the bug this case exists for)", async () => {
    await withCountedOps(["app_archive"], async (invocations) => {
      const refused = await hub("POST", "/api/hub/ops/app_archive", { slug: "news" });
      expect(refused.status).toBe(403);
      expect(times(invocations, "app_archive")).toBe(0);
    });
  });

  it("2. §13 · the same POST carrying the token the shell document bootstrapped succeeds and the handler ran exactly once (the allow-twin of 1 — without it, `throw 403` passes)", async () => {
    await withCountedOps(["app_archive"], async (invocations) => {
      const csrf = bootstrapCsrfOf(await page(paths.apps));
      const accepted = await hub("POST", "/api/hub/ops/app_archive", { slug: "news" }, { csrf });
      expect(accepted.status).toBe(200);
      // The op received the body as its input — a JSON surface hands it over whole, where
      // the form target carried its one argument in the query string.
      expect(invocations.get("app_archive")?.[0]).toMatchObject({ slug: "news" });
      expect(times(invocations, "app_archive")).toBe(1);
    });
  });

  it("3. §13 · a token minted under a different cookie session is 403, handler not invoked", async () => {
    await withCountedOps(["app_archive"], async (invocations) => {
      const foreignToken = bootstrapCsrfOf(await page(paths.apps, world.other.cookie));
      const refused = await hub("POST", "/api/hub/ops/app_archive", { slug: "news" }, { csrf: foreignToken });
      expect(refused.status).toBe(403);
      expect(times(invocations, "app_archive")).toBe(0);
      // The twin, so "403" is not simply what this endpoint always answers: the SAME
      // session's own token passes.
      const own = bootstrapCsrfOf(await page(paths.apps));
      expect((await hub("POST", "/api/hub/ops/app_archive", { slug: "news" }, { csrf: own })).status).toBe(200);
      expect(times(invocations, "app_archive")).toBe(1);
    });
  });

  it("4. §13 · every mutating form the pages render carries a CSRF field — walked out of the rendered HTML, never listed, so a new form cannot forget one — and one of those targets, posted without the field, is refused with its op never reaching a handler (the walk says the field is DRAWN; the refusal says it is READ)", async () => {
    // Three exclusions, all structural rather than convenient. /login is not walked at
    // all: there is no session yet to derive a token from. A form that posts to
    // better-auth's own mount is outside this module's gate by design — §4 gives that
    // surface its own origin defense, which is also why /login's forms carry no token.
    // And Sign out is the SHELL's form rather than any page's: layout.tsx renders it into
    // every signed-in page and LayoutProps carries no csrfToken to put in it, so what
    // stands in for the token there is the origin rule better-auth itself applied while
    // that form still posted to better-auth (pages/model's `paths.auth` says so).
    // Everything else that reaches a hub route is walked.
    let hubForms = 0;
    for (const [path, html] of Object.entries(await sessionPages())) {
      for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
        if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
        const action = decodeEntities(attributeOf(form[1], "action") ?? "");
        if (action.startsWith(`${paths.auth.base}/`)) continue;
        if (action === paths.auth.signOut) continue;
        hubForms += 1;
        expect(/name="csrf"\s+value="[^"]+"/.test(form[2]), `${action} on ${path} carries no CSRF field`).toBe(true);
      }
    }
    // The walk is proven to be looking at something: the pages really do render hub-owned
    // mutating forms, and every one of them was checked.
    expect(hubForms).toBeGreaterThan(0);

    // And the carrier is load-bearing, not decorative. One surviving server-rendered
    // mutation, taken end to end: `/settings/tokens/token_revoke` sits behind §13's
    // strictest prefix (`{recent: true}`), which this fresh session satisfies — so the
    // only thing left to refuse the post is the missing field, and it does. Since the
    // cutover this is the last mutating FORM in the suite that reaches an op at all, and
    // therefore the only remaining proof that the form carrier is still checked.
    await withCountedOps(["token_revoke"], async (invocations) => {
      const refused = await formPost(
        `${paths.settingsTokens}/token_revoke`,
        { id: "no-such-token" },
        world.session.cookie,
      );
      expect(refused.status, "POST /settings/tokens/token_revoke with no CSRF field").toBe(403);
      expect(times(invocations, "token_revoke")).toBe(0);
    });
  });

  it("5. §13 · /audit renders no mutating form at all — the shell it answers with since decision 36 carries no form and no `name=\"csrf\"` field, so \"no mutations, no CSRF surface\" holds by construction rather than by inspection", async () => {
    const html = await page(paths.audit);
    // The shell document renders NO form — not even Sign out, which lives in the client's
    // own chrome — so the walk is total over an empty set and the field cannot be there.
    expect(formsRenderedOn(html)).toEqual([]);
    expect(html).not.toContain('name="csrf"');
  });

  it("5b. §13 · the one surviving mutating POST under /apps — `/apps/connect`, whose 303 goes to a third-party authorize URL and so cannot be a fetch — is refused 403 without the CSRF field, and the connect it would have started never happened: no upstream_oauth_state row was written (the twin: the same post WITH the field starts one)", async () => {
    // What this replaces: `/apps` and the app page left `sessionPages()` with the cutover,
    // so no server-HTML walk can see the Connect form's CSRF field any more — the client
    // renders it. The field's presence is therefore unobservable here and its EFFECT is
    // what is checked instead, which is the stronger of the two claims.
    const target = `${paths.appConnect("")}?slug=notion`;
    const stateCount = async (): Promise<number> => {
      const row = await (env.DB as D1Like)
        .prepare(`SELECT COUNT(*) AS n FROM upstream_oauth_state`)
        .first<{ n: number }>();
      return row?.n ?? 0;
    };

    const before = await stateCount();
    const refused = await post(target, {});
    expect(refused.status).toBe(403);
    // `beginConnect` writes the single-use state row before it answers, so an unchanged
    // count is "it was never called" said in the only way a route-level test can say it.
    expect(await stateCount(), "a refused connect still started one").toBe(before);

    // THE TWIN: the same post carrying the session's own token reaches upstream and
    // redirects into the authorization server, which is why the form still exists at all.
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    const started = await post(target, {}, { csrf });
    expect(started.status).toBe(303);
    expect(new URL(started.headers.get("Location") ?? "", ORIGIN).host).toBe(AS_HOST);
    expect(await stateCount()).toBe(before + 1);
  });
});

/* ------------------------------------------------------------------ *
 * The SPA boundary (2026-09-18): the shell document, its two assets, and /api/hub
 * ------------------------------------------------------------------ */

/** Every URL the shell answers at for one (app, agent, pair) — built from the pane lists,
 *  so a pane added to `APP_PANES` or `AGENT_PANES` is walked with no edit here. */
function shellUrls(app: string, agent: string): string[] {
  return [
    paths.apps,
    paths.appNew,
    paths.appDetail(app),
    ...APP_PANES.map((pane) => paths.appPane(app, pane)),
    paths.agents,
    paths.agentNew,
    paths.agentDetail(agent),
    ...AGENT_PANES.map((pane) => paths.agentPane(agent, pane)),
    paths.agentApp(agent, app),
  ];
}

describe("§13 · the SPA shell document", () => {
  it("§13 · every /apps and /agents URL answers ONE document — 200, `Cache-Control: no-store`, the `#pmcp-bootstrap` JSON island carrying this session's CSRF token and username, and the `/app.js` module tag — and nothing that renders a pane server-side: the panes are the client's now, so the document is the same bytes whichever of them was asked for", async () => {
    const urls = shellUrls("news", "agent");
    // The pane lists really are being walked, not an empty array dressed as one.
    expect(urls.length).toBeGreaterThan(APP_PANES.length + AGENT_PANES.length);
    // The session's one token: every document must carry the SAME one, because it is
    // derived from the session and not from the route.
    const expected = bootstrapCsrfOf(await page(paths.apps));
    for (const url of urls) {
      const answered = await get(url);
      expect(answered.status, `GET ${url}`).toBe(200);
      // A session-derived token is in the body, so a stored copy is another owner's page.
      expect(answered.headers.get("Cache-Control"), `GET ${url}`).toBe("no-store");
      const html = await answered.text();
      expect(html, url).toContain('id="pmcp-bootstrap"');
      expect(html, url).toContain('src="/app.js"');
      // The two facts no API can report, because both are the session's — read through
      // the island's own JSON, which is what the client reads.
      expect(bootstrapCsrfOf(html), url).toBe(expected);
      expect(html, url).toContain(world.ns.owner.username);
    }
  });

  it("§13 · the session gate runs BEFORE the document: every one of those URLs with no cookie is a 302 to /login carrying its own path as next=, never a 200 whose client would discover the refusal afterwards", async () => {
    for (const url of shellUrls("news", "agent")) {
      const answered = await call(new Request(`${ORIGIN}${url}`));
      expect(answered.status, `GET ${url} with no cookie`).toBe(302);
      expect(answered.headers.get("Location"), `GET ${url}`).toBe(
        `/login?next=${encodeURIComponent(url)}`,
      );
    }
    // Spelled once, byte for byte, because `next=` is what a bookmark survives on.
    expect((await call(new Request(`${ORIGIN}${paths.apps}`))).headers.get("Location")).toBe(
      "/login?next=%2Fapps",
    );
  });

  it("§13 · /approvals and /approvals/<id> answer the same shell (decision 38) — 200, `no-store`, and a `#pmcp-bootstrap` island that is exactly `{csrf, username, origin, vapidPublicKey}`, the key being the configured VAPID public one the push control subscribes with — while with no cookie each is the 302 to /login carrying its own path as next=, so the `-32003` link and a push tap still land after a sign-in", async () => {
    const expected = bootstrapOf(await page(paths.apps));
    for (const url of [paths.approvals, paths.approval(world.approvalId)]) {
      const answered = await get(url);
      expect(answered.status, `GET ${url}`).toBe(200);
      expect(answered.headers.get("Cache-Control"), `GET ${url}`).toBe("no-store");
      const html = await answered.text();
      expect(html, url).toContain('src="/app.js"');
      const bootstrap = bootstrapOf(html);
      expect(Object.keys(bootstrap).sort(), url).toEqual(["csrf", "origin", "username", "vapidPublicKey"]);
      expect(bootstrap.vapidPublicKey, url).toBe((env as unknown as Env).VAPID_PUBLIC_KEY);
      expect(bootstrap.username, url).toBe(world.ns.owner.username);
      expect(bootstrap.origin, url).toBe(ORIGIN);
      // The island is the session's, not the route's: every shell carries the same one.
      expect(bootstrap, url).toEqual(expected);

      const anonymous = await call(new Request(`${ORIGIN}${url}`));
      expect(anonymous.status, `GET ${url} with no cookie`).toBe(302);
      expect(anonymous.headers.get("Location"), url).toBe(`/login?next=${encodeURIComponent(url)}`);
    }
  });

  it("§13 · the existence check runs before the document too: an unknown slug, ANOTHER namespace's real slug, the builtin pmcp and an (agent × app) pair the agent may not edit are one 404 apiece, byte-identical — a probe learns nothing about another namespace, and a 200 followed by a client-rendered \"not found\" would leak exactly that", async () => {
    const foreign = await seedNamespace(env.DB, {
      apps: [{ slug: uniqueSlug("foreign"), kind: "tunnel" }],
    });
    const foreignSlug = Object.keys(foreign.apps)[0];

    const yardstick = await get(paths.appDetail(uniqueSlug("nosuch")));
    expect(yardstick.status).toBe(404);
    const body = await yardstick.text();
    for (const url of [
      paths.appDetail(foreignSlug),
      paths.appDetail(PMCP_SLUG),
      // Every pane of an unknown app, not just its landing: the check is the route's, and
      // a pane that skipped it would render a shell for a namespace that has no such row.
      ...APP_PANES.map((pane) => paths.appPane(uniqueSlug("nosuch"), pane)),
      paths.agentDetail(uniqueSlug("noagent")),
      // `parked` is archived and this agent holds nothing on it, which is precisely the
      // pair §13 makes unreachable — while an archived app the agent DOES hold stays
      // editable, which is why the rule is not "archived is 404".
      paths.agentApp("agent", "parked"),
      paths.agentApp("agent", foreignSlug),
      paths.agentApp(uniqueSlug("noagent"), "news"),
    ]) {
      const answered = await get(url);
      expect(answered.status, url).toBe(404);
      expect(await answered.text(), url).toBe(body);
    }
  });

  it("§13 · pane-name validation stays AHEAD of the session gate: /apps/<slug>/tools is the same 404 with a cookie and without one, because whether a segment names a page cannot depend on who is asking", async () => {
    const withCookie = await get(`${paths.appDetail("news")}/tools`);
    const without = await call(new Request(`${ORIGIN}${paths.appDetail("news")}/tools`));
    expect(withCookie.status).toBe(404);
    expect(without.status).toBe(404);
    expect(await without.text()).toBe(await withCookie.text());
    // The twin, so "404" is not what this prefix always answers: `catalog` IS a pane.
    expect((await get(paths.appPane("news", "catalog"))).status).toBe(200);
  });
});

describe("§13 · the client bundle's two assets", () => {
  it("§13 · GET /app.js is 200 JavaScript and GET /app.css is 200 CSS — the two routes that reach the ASSETS binding, and the only ones: the shell links them by these exact names and a document whose script 404s is a blank page", async () => {
    const script = await get(paths.clientScript);
    expect(script.status, "GET /app.js").toBe(200);
    expect(script.headers.get("Content-Type") ?? "", "GET /app.js").toMatch(/javascript/);

    const sheet = await get(paths.clientStylesheet);
    expect(sheet.status, "GET /app.css").toBe(200);
    expect(sheet.headers.get("Content-Type") ?? "", "GET /app.css").toMatch(/text\/css/);

    // And the shell really asks for these two names, so the pair is not two routes nobody
    // links: the document's own tags are what makes them load-bearing.
    const shell = await page(paths.apps);
    expect(shell).toContain(`src="${paths.clientScript}"`);
    expect(shell).toContain(`href="${paths.clientStylesheet}"`);
  });
});

describe("§13 · /api/hub — the write gate, in the order it is written", () => {
  // Four refusals, one per barrier, each proving its own place in the order AND that the
  // handler behind it never ran. `withCountedOps` over the whole table is what makes the
  // second half sayable: a substituted handler records its input and does nothing, so a
  // refusal that had already executed would still be counted.
  it("§13 · no cookie is 401 with a JSON body — and it is 401 even when the Origin is foreign and the token is absent, which is the session barrier standing FIRST (a fetch cannot follow a redirect into the address bar, so this is 401 where the page gate is 302)", async () => {
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      const refused = await hub(
        "POST",
        "/api/hub/ops/app_archive",
        { slug: "news" },
        { cookie: null, csrf, origin: "https://evil.example" },
      );
      expect(refused.status).toBe(401);
      expect(refused.headers.get("Content-Type") ?? "").toContain("application/json");
      expect(await reasonOf(refused)).toBe("Sign in again.");
      expect(times(invocations, "app_archive")).toBe(0);
    });
  });

  it("§13 · a foreign Origin is 403 even carrying the session's own valid token — the origin barrier is the hub's, not a re-reading of the token (the twin: the hub's own Origin on the same request passes)", async () => {
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      const refused = await hub(
        "POST",
        "/api/hub/ops/app_archive",
        { slug: "news" },
        { csrf, origin: "https://evil.example" },
      );
      expect(refused.status).toBe(403);
      expect(await reasonOf(refused)).toBe("Forbidden");
      expect(times(invocations, "app_archive")).toBe(0);

      const accepted = await hub("POST", "/api/hub/ops/app_archive", { slug: "news" }, { csrf, origin: ORIGIN });
      expect(accepted.status).toBe(200);
      expect(times(invocations, "app_archive")).toBe(1);
    });
  });

  it("§13 · the CSRF header is its own barrier: a same-origin write with the cookie and no `X-Pmcp-Csrf` is 403 and reaches nothing — a custom header cannot be set cross-origin without a preflight the hub never answers, so its absence is refused rather than tolerated", async () => {
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      const refused = await hub("POST", "/api/hub/ops/app_archive", { slug: "news" }, { origin: ORIGIN });
      expect(refused.status).toBe(403);
      expect(await reasonOf(refused)).toBe("Forbidden");
      expect(times(invocations, "app_archive")).toBe(0);
    });
  });

  it("§13 · a body that is not a JSON object is 400 — and the SAME body with no CSRF header is 403, which is the body barrier standing LAST: nothing is parsed on behalf of a request that was never going to be admitted", async () => {
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const body of ["not json at all", "[]", '"a string"', "7"]) {
        const refused = await hub("POST", "/api/hub/ops/app_archive", body, { csrf });
        expect(refused.status, body).toBe(400);
        expect(await reasonOf(refused), body).toBe("Body must be a JSON object.");
      }
      // The order, made observable: strip the token and the same unparseable body is
      // refused by the token instead.
      const earlier = await hub("POST", "/api/hub/ops/app_archive", "not json at all");
      expect(earlier.status).toBe(403);
      expect(times(invocations, "app_archive")).toBe(0);
    });
  });
});

/**
 * The typed routes' own world — its own namespace, because every case here WRITES.
 *
 * Proxied apps throughout, and deliberately so: a proxied app declares no roles, so its
 * `roles` IS the owner map the Roles route edits, and no tunnel has to be dialled to give
 * these cases something to compose against. The upstream is never reached — none of the
 * six typed routes reads a catalog, which is the property three of the cases below exist
 * to pin — so its URL only has to be well-formed.
 */
let typedWorld: Promise<{ ns: SeededNamespace; cookie: string; csrf: string }> | null = null;
const withTypedWorld = (): Promise<{ ns: SeededNamespace; cookie: string; csrf: string }> =>
  (typedWorld ??= seedTypedWorld());

const TYPED_ROLE_APP = uniqueSlug("roleapp");
const TYPED_RECORD_APP = uniqueSlug("recapp");
const TYPED_GRANT_APP = uniqueSlug("grantapp");
const TYPED_TOKEN_APP = uniqueSlug("tokapp");
const TYPED_AGENT = uniqueSlug("holder");

async function seedTypedWorld(): Promise<{ ns: SeededNamespace; cookie: string; csrf: string }> {
  const upstream = upstreamUrlFor({ id: uniqueSlug("typedup"), mode: { kind: "unreachable" } });
  const proxied = { kind: "proxy" as const, upstreamUrl: upstream, upstreamAuthMode: "headers" as const };
  const ns = await seedNamespace(env.DB, {
    apps: [
      // Two literals in one role, so a save that draws ONE of them has an undrawn literal
      // to leave alone — which is the whole of the filtered-save contract.
      { slug: TYPED_ROLE_APP, ...proxied, roles: { mine: { tools: ["get_paper", "put_paper"] } } },
      // Two tools, each masked on a path of its own, so "another tool's mask" exists.
      { slug: TYPED_RECORD_APP, ...proxied, redact: { alpha_call: ["note"], beta_call: ["only_beta"] } },
      { slug: TYPED_GRANT_APP, ...proxied, roles: { reader: { tools: ["get_paper"] } } },
      { slug: TYPED_TOKEN_APP, kind: "tunnel" as const },
    ],
    agents: [{ slug: TYPED_AGENT, grants: { [TYPED_GRANT_APP]: [{ role: "reader", mode: "allow" }] } }],
  });
  const session = await seedOwnerSession(ns.owner);
  return { ns, cookie: session.cookie, csrf: bootstrapCsrfOf(await page(paths.apps, session.cookie)) };
}

/** One `app_get` answer, typed by the contract the op declares. `handler` erases its
 *  result to `unknown` for every caller, and `admin.AppRow` is where the shape is written
 *  down — so this asserts to the OP's own type rather than to one invented here. */
async function appGetRow(ownerId: string, slug: string): Promise<OpsAppRow> {
  const answered = (await ops.app_get.handler(ownerId, { slug })) as { app: OpsAppRow };
  return answered.app;
}

/** One role's tool list out of a stored map. §20.3 writes a tools-only role EITHER as the
 *  bare array shorthand or as `{ tools: [...] }`, and which one is stored depends on how it
 *  was written — so a case comparing what a save did has to read through both spellings or
 *  it would be asserting about the shorthand rather than about the save. */
function roleTools(roles: RoleDeclaration, role: string): string[] {
  const held = roles[role];
  if (held === undefined) return [];
  return Array.isArray(held) ? held : (held.tools ?? []);
}


describe("§13 · /api/hub — the six typed routes, where the client sends a DELTA", () => {
  it("§4/§9 · a FILTERED role save is a delta over the rows the editor drew: `drawn` naming one of the role's two literals removes exactly that one when it comes back unticked, and the literal the editor never drew survives untouched — which is what makes `?q=` safe, because a hidden row is not an unticked one", async () => {
    const { ns, cookie, csrf } = await withTypedWorld();
    expect(roleTools((await appGetRow(ns.owner.userId, TYPED_ROLE_APP)).roles, "mine")).toEqual([
      "get_paper",
      "put_paper",
    ]);

    const saved = await hub(
      "PUT",
      `/api/hub/apps/${TYPED_ROLE_APP}/roles`,
      // The editor drew ONE row and it came back unticked; `put_paper` was filtered out of
      // the render entirely, so it is in neither list.
      { was: "mine", role: "mine", drawn: ["tools/get_paper"], ticked: [], keeps: [] },
      { cookie, csrf },
    );
    expect(saved.status, await saved.text()).toBe(200);

    expect(roleTools((await appGetRow(ns.owner.userId, TYPED_ROLE_APP)).roles, "mine")).toEqual([
      "put_paper",
    ]);
  });

  it("§4/§9 · a save whose family could not be READ changes no literal at all: an empty `drawn` — the editor rendered no item row, which is exactly what an unread catalog produces — leaves the role's stored patterns byte-identical, so a 503 upstream can never silently narrow a grant", async () => {
    const { ns, cookie, csrf } = await withTypedWorld();
    // Its own role on the same app, so the case above cannot have moved it.
    await ops.app_update.handler(ns.owner.userId, {
      slug: TYPED_ROLE_APP,
      roles: { unread: { tools: ["get_paper", "put_paper"], prompts: ["digest_daily"] } },
    });
    const before = (await appGetRow(ns.owner.userId, TYPED_ROLE_APP)).roles;

    const saved = await hub(
      "PUT",
      `/api/hub/apps/${TYPED_ROLE_APP}/roles`,
      { was: "unread", role: "unread", drawn: [], ticked: [], keeps: [] },
      { cookie, csrf },
    );
    expect(saved.status, await saved.text()).toBe(200);

    expect((await appGetRow(ns.owner.userId, TYPED_ROLE_APP)).roles).toEqual(before);
  });

  it("§5/§9 · a recording save touches only the (path, tool) pairs the editor drew: masking one tool's path leaves ANOTHER tool's stored mask exactly as it was, because a pair the render never covered is not a pair the save has an opinion about", async () => {
    const { ns, cookie, csrf } = await withTypedWorld();
    const before = await appGetRow(ns.owner.userId, TYPED_RECORD_APP);
    expect(before.redact).toEqual({ alpha_call: ["note"], beta_call: ["only_beta"] });

    const saved = await hub(
      "PUT",
      `/api/hub/apps/${TYPED_RECORD_APP}/recording`,
      {
        logBodies: true,
        // One path row, covering one tool, and unticked — so alpha's mask comes off.
        // beta's path is not drawn at all, so nothing here speaks about it.
        args: { drawn: [["note", ["alpha_call"]]], wholePath: [], perTool: [] },
        results: { drawn: [], wholePath: [], perTool: [] },
      },
      { cookie, csrf },
    );
    expect(saved.status, await saved.text()).toBe(200);

    const after = await appGetRow(ns.owner.userId, TYPED_RECORD_APP);
    expect(after.redact.alpha_call, "the drawn pair did not move").toBeUndefined();
    expect(after.redact.beta_call, "an undrawn tool's mask was rewritten").toEqual(["only_beta"]);
  });

  it("§6/§8 · a refused grant save answers 422 carrying the op's own field-scoped violations — the reason names `roles`, the field the entry belongs to, and the pair's stored set is untouched (the twin: the same route with a declared role writes it)", async () => {
    const { ns, cookie, csrf } = await withTypedWorld();
    const refused = await hub(
      "PUT",
      `/api/hub/apps/${TYPED_GRANT_APP}/grants`,
      { agent: TYPED_AGENT, entries: { notarole: "allow" } },
      { cookie, csrf },
    );
    expect(refused.status).toBe(422);
    const body = await jsonOf(refused);
    expect(typeof body.reason).toBe("string");
    expect(body.violations, "the refusal carried no violations list").toEqual([
      { field: "roles", reason: expect.stringContaining("notarole") },
    ]);

    // Nothing was written: the pair still holds exactly what it held.
    const held = await grantsHeldBy(ns.owner.userId, TYPED_AGENT, TYPED_GRANT_APP);
    expect(held).toEqual(["reader"]);

    // THE TWIN: a declared role goes through the same route and REPLACES the set.
    const accepted = await hub(
      "PUT",
      `/api/hub/apps/${TYPED_GRANT_APP}/grants`,
      { agent: TYPED_AGENT, entries: { reader: "approval" } },
      { cookie, csrf },
    );
    expect(accepted.status, await accepted.text()).toBe(200);
    expect(await grantsHeldBy(ns.owner.userId, TYPED_AGENT, TYPED_GRANT_APP)).toEqual(["reader:approval"]);
  });

  it("§4/§15 · `token_issue` through the JSON surface reveals the plaintext EXACTLY once: the 200 carries a key that really opens the tunnel, and the credential listing afterwards carries only its prefix — nothing that could be presented", async () => {
    const { ns, cookie, csrf } = await withTypedWorld();
    const minted = await hub(
      "POST",
      "/api/hub/ops/token_issue",
      { kind: "app", slug: TYPED_TOKEN_APP },
      { cookie, csrf },
    );
    const answered = await jsonOf(minted);
    expect(minted.status, JSON.stringify(answered)).toBe(200);
    const value = answered.value;
    if (typeof value !== "object" || value === null || !("token" in value) || typeof value.token !== "string") {
      throw new Error("token_issue answered no plaintext");
    }
    const plaintext = value.token;

    // It is a real credential, not a placeholder: identity's own resolver admits it.
    const resolved = await resolveAppToken(
      new Request(`${ORIGIN}/connect`, { headers: { Authorization: `Bearer ${plaintext}` } }),
    );
    expect(resolved, "the revealed key does not open the tunnel").not.toBeNull();

    // ONCE: every later read of the same credential is the prefix and nothing more.
    const listed = await hub("GET", "/api/hub/tokens", undefined, { cookie });
    expect(listed.status).toBe(200);
    const body = await listed.text();
    expect(body, "the credential listing carried the plaintext").not.toContain(plaintext);
    expect(body).toContain(TYPED_TOKEN_APP);
    // And the ledger the walk just wrote did not keep it either (§15's uniform body rule).
    const rows = await query(env.DB, ns.owner.userId, { event: "token_issue" });
    expect(JSON.stringify(rows), "the audit trail kept the plaintext").not.toContain(plaintext);
  });
});

/** One (agent × app) pair's saved entries, read through `agent_list` — the same answer the
 *  grant editor reads, never the route's own echo of what it just sent. */
async function grantsHeldBy(ownerId: string, agent: string, app: string): Promise<string[]> {
  const listed = (await ops.agent_list.handler(ownerId, {})) as {
    agents: { slug: string; grants: Record<string, string[]> }[];
  };
  return listed.agents.find((each) => each.slug === agent)?.grants[app] ?? [];
}

describe("§4/§13 · cookie sessions are the only page credential", () => {
  it("6. §4 · a bearer-sourced (device-flow) session is refused on /settings · a browser session renders it (the twin — the guard is about provenance, not about being logged out)", async () => {
    const cookieName = world.session.cookie.split("=")[0];
    const replayed = await get(paths.settings, `${cookieName}=${world.deviceToken}`);
    expect(replayed.status).toBe(302);
    expect(replayed.headers.get("Location")).toMatch(/^\/login(\?|$)/);
    // The twin: the same page, the same guard, a browser session.
    const rendered = await get(paths.settings);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain(paths.auth.signOut);
  });

  it("7. §7 · an Authorization: Bearer header with no cookie opens no page — bearer tokens are never consulted on page routes", async () => {
    for (const bearer of [world.session.token, world.ns.tokens.agent.token, world.deviceToken]) {
      const refused = await call(
        new Request(`${ORIGIN}${paths.apps}`, { headers: { Authorization: `Bearer ${bearer}` } }),
      );
      expect(refused.status).toBe(302);
      expect(refused.headers.get("Location")).toMatch(/^\/login(\?|$)/);
    }
  });

  it("8. §13 · /approvals/<id> for another namespace's approval refuses · the owner's own id answers the shell (owner-only, and indistinguishable from a nonexistent id)", async () => {
    // Since decision 38 the owner's own id is the SPA shell, and the check that used to
    // decide what to render now decides whether a document exists at all — before any HTML,
    // as `/apps/<slug>` decides. The row's other half, the RECORD a probe could read, is 8b.
    const own = await get(paths.approval(world.approvalId));
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('id="pmcp-bootstrap"');
    const foreign = await get(paths.approval(world.foreign.approvalId));
    const invented = await get(paths.approval("apr_this-id-never-existed"));
    expect(foreign.status).toBe(404);
    // The two refusals are ONE answer: a probe cannot learn that the id exists elsewhere.
    expect(await foreign.text()).toEqual(await invented.text());
    expect(foreign.status).toBe(invented.status);
  });

  it("8b. §13 · GET /api/hub/approvals/<id> answers the owner's own row as `{ approval }` · another namespace's id and an invented one are one 404 `{ reason: \"No such approval.\" }`, byte-identical · no cookie is the reader's 401 (the JSON half of row 8, ported with decision 38)", async () => {
    const own = await hub("GET", `/api/hub/approvals/${world.approvalId}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("Cache-Control")).toBe("no-store");
    const approval = (await jsonOf(own)).approval as Record<string, unknown>;
    expect(approval.id).toBe(world.approvalId);
    expect(approval.status).toBe("pending");

    const foreign = await hub("GET", `/api/hub/approvals/${world.foreign.approvalId}`);
    const invented = await hub("GET", "/api/hub/approvals/apr_this-id-never-existed");
    expect(foreign.status).toBe(404);
    expect(invented.status).toBe(404);
    const refused = await foreign.text();
    expect(refused).toBe(await invented.text());
    expect(JSON.parse(refused)).toEqual({ reason: "No such approval." });

    const anonymous = await hub("GET", `/api/hub/approvals/${world.approvalId}`, undefined, { cookie: null });
    expect(anonymous.status).toBe(401);
    expect(await reasonOf(anonymous)).toBe("Sign in again.");
  });

  it("9. §13 · /manifest.webmanifest and /sw.js are served without a session — installability is not gated, and the PWA shell holds nothing to gate", async () => {
    for (const path of [paths.manifest, paths.serviceWorker]) {
      const anonymous = await call(new Request(`${ORIGIN}${path}`));
      expect(anonymous.status, path).toBe(200);
      const body = await anonymous.text();
      // Nothing namespace-shaped is in either: the shell is the same bytes for everyone.
      expect(body).not.toContain(world.ns.owner.username);
    }
  });
});

describe("§13 · /audit — the explorer's shell, its two reads, and the export beneath them", () => {
  // The page the four describes here used to walk is gone (decision 36): `/audit` is the
  // SPA's third route family, so what this file owns about it is the BOUNDARY — the shell
  // document and its gate, the two JSON reads the client makes, and the export route that
  // was always a Worker route and stays one. What the deleted describes proved about
  // RENDERING (the three no-bodies sentences, the stub spellings, the merge, the facets) is
  // `server/test/unit/audit-derive.test.ts`'s and the gallery's now.
  //
  // Two rows of the deleted paging describe survive in spirit and are kept below, because
  // their subject is the export rather than the page: the line count equals `total`, and an
  // exported row carries its stubs and never the bytes they stand for.

  /** A dispatched call row with NO bodies, on the seeded proxied app whose §15 default is
   *  bodies-off — the window read's `noBodies` needs a subject, and the world's own nine
   *  rows all carry bodies. */
  const BODILESS_TOOL = "window-bodiless-tool";

  /**
   * The four rows that make a cross product observable: the same two tool names under both
   * seeded apps. An export of two (app, tool) PAIRS must return two of these four — a split
   * into `app IN (…) AND tool IN (…)` returns all four and the owner never sees that it
   * widened.
   */
  const CROSS_TOOLS = ["cross-a", "cross-b"] as const;
  const CROSS_APPS = ["news", "notion"] as const;

  /** A `tool` column holding a resource URI (§20.4) — the reason a pair travels as its own
   *  key split at the FIRST slash rather than as two keys or one slash-joined `tool=`. */
  const URI_TOOL = "news://articles/1";

  beforeAll(async () => {
    const call = {
      ownerId: world.ns.owner.userId,
      principal: "agent:agent",
      event: "tools/call",
      outcome: "ok",
      durationMs: 7,
      client: { name: "walker", version: "1.0", sessionId: SHARED_SESSION },
    };
    await record(env.DB, { ...call, app: "notion", tool: BODILESS_TOOL });
    for (const app of CROSS_APPS) {
      for (const tool of CROSS_TOOLS) await record(env.DB, { ...call, app, tool });
    }
    await record(env.DB, { ...call, app: "news", event: "resources/read", tool: URI_TOOL });
  });

  /** One window read, as the client makes it: the session cookie and nothing else. */
  async function windowRead(search = ""): Promise<Record<string, unknown>> {
    const answered = await hub("GET", `/api/hub/audit/window${search}`);
    expect(answered.status, `GET /api/hub/audit/window${search}`).toBe(200);
    expect(answered.headers.get("Cache-Control")).toBe("no-store");
    return jsonOf(answered);
  }

  /** The window's rows as the slim shape they are — the client's own type, checked here
   *  only for the fields this file asserts on. */
  function windowRows(body: Record<string, unknown>): Record<string, unknown>[] {
    return body.rows as Record<string, unknown>[];
  }

  it("§13 · GET /audit answers the SPA shell exactly as /apps and /agents do — 200, `no-store`, this session's `#pmcp-bootstrap` island and the `/app.js` tag — and the session gate still runs before the document: no cookie is the 302 to /login carrying /audit as next=", async () => {
    const answered = await get(paths.audit);
    expect(answered.status).toBe(200);
    expect(answered.headers.get("Cache-Control")).toBe("no-store");
    const html = await answered.text();
    expect(html).toContain('id="pmcp-bootstrap"');
    expect(html).toContain('src="/app.js"');
    // The same session token every other shell carries: it is the session's, not the route's.
    expect(bootstrapCsrfOf(html)).toBe(bootstrapCsrfOf(await page(paths.apps)));

    const anonymous = await call(new Request(`${ORIGIN}${paths.audit}`));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(paths.audit)}`);
  });

  it("§13 · both new reads are `reader` routes like the other ten: with no cookie each is a 401 JSON body telling the client to sign in — never a 302 a `fetch` could not follow", async () => {
    for (const path of ["/api/hub/audit/window", "/api/hub/audit/1"]) {
      const answered = await hub("GET", path, undefined, { cookie: null });
      expect(answered.status, path).toBe(401);
      expect(await reasonOf(answered), path).toBe("Sign in again.");
    }
  });

  it("§13 · the window read answers one page of SLIM rows — never `args`, never `result`, never the namespace id, and `argsHead`/`hasResult`/`noBodies` in their place — over the whole retention window it resolved and echoed, with `total` the count audit.query holds for that window and `ceiling` the AUDIT_EXPLORER_ROWS the notice is rendered from", async () => {
    const body = await windowRead();
    const since = body.since as number;
    const until = body.until as number;
    // The server resolves "now" and echoes both ends, so the client never computes it
    // twice — and the window it resolved is the retention window, not a page-sized guess.
    expect(until - since).toBe(RETENTION_DAYS * 86_400_000);
    expect(body.retentionDays).toBe(RETENTION_DAYS);
    expect(body.ceiling).toBe(AUDIT_EXPLORER_ROWS);
    const truth = await query(env.DB, world.ns.owner.userId, { since, until });
    expect(body.total).toBe(truth.total);

    const rows = windowRows(body);
    expect(rows.length).toBe(Math.min(truth.total, AUDIT_EXPLORER_PAGE));
    for (const row of rows) {
      expect(row, `row ${String(row.id)} shipped a body`).not.toHaveProperty("args");
      expect(row, `row ${String(row.id)} shipped a body`).not.toHaveProperty("result");
      expect(row, `row ${String(row.id)} shipped the namespace id`).not.toHaveProperty("ownerId");
      expect(typeof row.hasResult, `row ${String(row.id)} has no hasResult`).toBe("boolean");
    }

    // A row that recorded bodies says so without shipping them…
    const bodied = rows.find((row) => row.tool === `${TOOL_PREFIX}1`);
    expect(bodied, "the seeded bodied row is not in the window").toBeDefined();
    expect(String(bodied?.argsHead)).toBe(JSON.stringify({ q: "term", token: "‹redacted›" }).slice(0, AUDIT_ARGS_HEAD_CHARS));
    expect(bodied?.hasResult).toBe(true);
    expect(bodied, "a row WITH bodies explained their absence").not.toHaveProperty("noBodies");

    // …and one that recorded none carries the same sentence key the page-rendered row did.
    const bare = rows.find((row) => row.tool === BODILESS_TOOL);
    expect(bare, "the bodiless row is not in the window").toBeDefined();
    expect(bare).not.toHaveProperty("argsHead");
    expect(bare?.hasResult).toBe(false);
    expect(bare?.noBodies).toBe("off");
  });

  it("§13 · the window read takes the search as `text` and the page as `offset`: a needle narrows to the rows that carry it, and an `offset` at AUDIT_EXPLORER_ROWS answers an EMPTY page while `total` still reports the whole match — the ceiling bounds what is loaded, never what matched", async () => {
    const narrowed = await windowRead(`?text=${encodeURIComponent(BODILESS_TOOL)}`);
    expect(narrowed.total).toBe(1);
    expect(windowRows(narrowed).map((row) => row.tool)).toEqual([BODILESS_TOOL]);

    const past = await windowRead(`?offset=${AUDIT_EXPLORER_ROWS}`);
    expect(windowRows(past)).toEqual([]);
    expect(past.total, "the ceiling emptied the count as well as the page").toBe((await windowRead()).total);
  });

  it("§13 · the last page never crosses the ceiling: the window read asks `audit_query` for AUDIT_EXPLORER_PAGE rows at offset 0, for exactly the remainder at a non-aligned offset near the ceiling, and for none at or past it — a page size the route did not clamp would load rows beyond the ceiling it echoes", async () => {
    // Read at the SEAM rather than from the answer: observing a clamp behaviourally would
    // need a ledger of AUDIT_EXPLORER_ROWS rows, and what the clamp actually is is the
    // `limit` this route asks the op for.
    const asked = await withStubbedAuditQuery(async (inputs) => {
      for (const offset of [0, AUDIT_EXPLORER_ROWS - 1, AUDIT_EXPLORER_ROWS, AUDIT_EXPLORER_ROWS + 500]) {
        await windowRead(`?offset=${offset}`);
      }
      return inputs.map((input) => ({ offset: input.offset, limit: input.limit }));
    });
    expect(asked).toEqual([
      { offset: 0, limit: AUDIT_EXPLORER_PAGE },
      { offset: AUDIT_EXPLORER_ROWS - 1, limit: 1 },
      { offset: AUDIT_EXPLORER_ROWS, limit: 0 },
      { offset: AUDIT_EXPLORER_ROWS + 500, limit: 0 },
    ]);
  });

  /**
   * Runs `work` with `audit_query` substituted for one that records its input and answers an
   * empty page — the `withCountedOps` mechanism (its comment says why a substitution is how
   * "what did the route ask for" is asked at all), with a body this route can actually
   * consume. Restored in a `finally`, so a leaked substitution cannot reach a sibling case.
   */
  async function withStubbedAuditQuery<T>(
    work: (inputs: Record<string, unknown>[]) => Promise<T>,
  ): Promise<T> {
    const real = ops.audit_query;
    const inputs: Record<string, unknown>[] = [];
    ops.audit_query = {
      schema: real.schema,
      handler: async (_ownerId: string, input: unknown) => {
        inputs.push(input as Record<string, unknown>);
        return { rows: [], total: 0 };
      },
    };
    try {
      return await work(inputs);
    } finally {
      ops.audit_query = real;
    }
  }

  it("§13 · the record read answers ONE full row by id — bodies, stubs and the `noBodies` sentence included — and its 404 covers a row outside the caller's namespace exactly as it covers one that never existed and a segment that is not an id at all · the same row IS readable under its own namespace's session (the allow-twin)", async () => {
    const [bodied] = await exportLines(new URLSearchParams({ tool: `${TOOL_PREFIX}1` }));
    const own = await hub("GET", `/api/hub/audit/${bodied.id}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("Cache-Control")).toBe("no-store");
    const read = (await jsonOf(own)).row as Record<string, unknown>;
    expect(read.id).toBe(bodied.id);
    expect(read.args).toEqual({ q: "term", token: "‹redacted›" });
    expect(read.result).toEqual({ content: [{ stub: "blob", contentType: "image/png", bytes: 4_200_000 }] });
    expect(read, "the record read shipped the namespace id").not.toHaveProperty("ownerId");

    // A row of the foreign namespace, reachable only by its own owner.
    const foreignRows = await query(env.DB, world.foreign.ns.owner.userId, {});
    const foreignId = foreignRows.rows[0]?.id;
    expect(foreignId, "the foreign namespace recorded nothing").toBeDefined();
    const yardstick = await hub("GET", `/api/hub/audit/${bodied.id + 1_000_000}`);
    expect(yardstick.status).toBe(404);
    const refusal = await yardstick.text();
    for (const path of [`/api/hub/audit/${foreignId}`, "/api/hub/audit/not-a-number"]) {
      const answered = await hub("GET", path);
      expect(answered.status, path).toBe(404);
      expect(await answered.text(), path).toBe(refusal);
    }

    const theirs = await seedOwnerSession(world.foreign.ns.owner);
    const allowed = await hub("GET", `/api/hub/audit/${foreignId}`, undefined, { cookie: theirs.cookie });
    expect(allowed.status, "the row its own owner recorded is unreadable to them").toBe(200);
  });

  it("§13 · the export accepts REPEATED principal/app/event/tool/session/outcome keys, in RAW outcome codes — a two-value key is the union of its singles — plus `text`, while `limit`, `offset` and `expand` are ignored as they always were · a single-valued old bookmark still narrows exactly as it did (the twin)", async () => {
    const two = await exportLines(new URLSearchParams([["tool", `${TOOL_PREFIX}1`], ["tool", `${TOOL_PREFIX}2`]]));
    expect(two.map((row) => row.tool).sort()).toEqual([`${TOOL_PREFIX}1`, `${TOOL_PREFIX}2`]);
    // The old link's shape, still exactly one of them: repeated keys widen, they do not
    // replace the spelling every bookmark in the wild already carries.
    const one = await exportLines(new URLSearchParams({ tool: `${TOOL_PREFIX}1` }));
    expect(one.map((row) => row.tool)).toEqual([`${TOOL_PREFIX}1`]);

    // A display class is the page's grouping and never reaches here: the link expands it,
    // and what arrives is the raw codes the ledger stores.
    const codes = await exportLines(new URLSearchParams([["outcome", "-32001"], ["outcome", "ok"], ["app", "news"]]));
    expect(new Set(codes.map((row) => row.outcome))).toEqual(new Set(["-32001", "ok"]));

    const searched = await exportLines(new URLSearchParams({ text: BODILESS_TOOL }));
    expect(searched.map((row) => row.tool)).toEqual([BODILESS_TOOL]);

    // The page's own paging keys are not the export's: an export is always the complete
    // match (§8), whatever a link carries beside the filters.
    const paged = await exportLines(
      new URLSearchParams({ tool: `${TOOL_PREFIX}1`, limit: "1", offset: "5", expand: "3" }),
    );
    expect(paged.map((row) => row.id)).toEqual(one.map((row) => row.id));
  });

  it("§13 · the export emits exactly `total` lines for its filters, each row carrying its recorded bodies post-redaction with stubs as they were stored — never the bytes a blob stub stands for", async () => {
    const filters = { event: "tools/call", app: "news" };
    const truth = await query(env.DB, world.ns.owner.userId, filters as AuditQuery);
    const lines = await exportLines(new URLSearchParams(filters));
    expect(lines.length).toBe(truth.total);
    const [row] = await exportLines(new URLSearchParams({ tool: `${TOOL_PREFIX}1` }));
    expect(row.args).toEqual({ q: "term", token: "‹redacted›" });
    expect(row.result).toEqual({ content: [{ stub: "blob", contentType: "image/png", bytes: 4_200_000 }] });
  });

  it("§13 · a selected tool is a PAIR: repeated `target=<app>/<tool>` keeps each (app, tool) together, so two targets export exactly those two — the `app IN (…) AND tool IN (…)` split that two keys would produce also exports the two combinations the page never showed, and an export that silently widens is the one failure a ledger may not have", async () => {
    const targets = new URLSearchParams([
      ["target", `${CROSS_APPS[0]}/${CROSS_TOOLS[0]}`],
      ["target", `${CROSS_APPS[1]}/${CROSS_TOOLS[1]}`],
    ]);
    const paired = await exportLines(targets);
    expect(paired.map((row) => `${String(row.app)}/${String(row.tool)}`).sort()).toEqual([
      `${CROSS_APPS[0]}/${CROSS_TOOLS[0]}`,
      `${CROSS_APPS[1]}/${CROSS_TOOLS[1]}`,
    ]);

    // The cross product the split WOULD have returned, spelled out — so this row fails with
    // four lines rather than passing because the seed happened to hold two.
    const crossed = await exportLines(
      new URLSearchParams([
        ["app", CROSS_APPS[0]],
        ["app", CROSS_APPS[1]],
        ["tool", CROSS_TOOLS[0]],
        ["tool", CROSS_TOOLS[1]],
      ]),
    );
    expect(crossed.length, "the four seeded combinations are not all there").toBe(4);

    // A `tool` column may hold a resource URI (§20.4), which is exactly why a pair is split
    // at the FIRST slash: an app slug never contains one and the tool side keeps all of its.
    const uri = await exportLines(new URLSearchParams([["target", `news/${URI_TOOL}`]]));
    expect(uri.map((row) => row.tool)).toEqual([URI_TOOL]);
  });

  it("§13 · a malformed `target` is a 400, never an ignored key: no slash at all, an empty app and an empty tool are each refused before any read — ignoring a filter WIDENS an export, and a download that quietly carries more rows than were asked for is worse than one that refuses", async () => {
    for (const bad of ["news", "/get_news", "news/", "/"]) {
      const answered = await get(`${paths.auditExport}?target=${encodeURIComponent(bad)}`);
      expect(answered.status, `target=${bad}`).toBe(400);
      expect(await answered.text(), `target=${bad}`).toContain("Bad target.");
    }
    // The twin: a well-formed one beside them streams its rows.
    expect((await exportLines(new URLSearchParams([["target", `news/${CROSS_TOOLS[0]}`]]))).length).toBe(1);
  });

  it("§13/§15 · a selection with more filter values than one statement can bind is refused 400 before any read — D1 binds at most a hundred parameters per statement and the page's \"Show all N\" can tick more than that, so the owner gets a sentence instead of a database error mid-download · one value under the bound streams (the twin)", async () => {
    const values = (count: number): URLSearchParams =>
      new URLSearchParams(Array.from({ length: count }, (_, at) => ["tool", `${TOOL_PREFIX}${at}`]));

    const over = await get(`${paths.auditExport}?${values(AUDIT_EXPORT_MAX_VALUES + 1).toString()}`);
    expect(over.status).toBe(400);
    expect(await over.text()).toContain("Too many filter values for one export");

    // At the bound exactly, and therefore under D1's own: the refusal is a bound on the
    // SELECTION, not a bound that has already been crossed.
    const at = await exportLines(values(AUDIT_EXPORT_MAX_VALUES));
    expect(at.length, "the seeded ledger holds the tools this selection names").toBeGreaterThan(0);

    // A pair binds two parameters, so a `target` counts twice toward the same bound.
    const pairs = new URLSearchParams(
      Array.from({ length: AUDIT_EXPORT_MAX_VALUES / 2 + 1 }, () => ["target", `news/${CROSS_TOOLS[0]}`]),
    );
    expect((await get(`${paths.auditExport}?${pairs.toString()}`)).status).toBe(400);
  });
});

describe("§13 · /approvals — deciding a request that is no longer pending", () => {
  // G52 (2026-09-03): the lost race — a request decided or expired between the page
  // render and the click — landed as a red "Approval decide failed" through the generic
  // dispatch. §13 now pins the calm answer. approval_decide refuses every non-decidable
  // id with one message on purpose (§7's probe rule), so the tone is keyed on the op.
  //
  // Ported with decision 38: both pages decide through `POST /api/hub/ops/approval_decide`
  // (the `/approvals/:op` form target is gone), so what the server owes is the 422 that a
  // lost race answers — the op's one message, keyed by the op's name. The WARNING it lands
  // as is the client's: `web/src/lib/notice.ts` keys the tone on `approval_decide`, pinned
  // by the web unit row over that file.
  it(`§13 · deciding an approval that is no longer pending through the JSON surface is a 422 carrying the op's one refusal — byte-identical to an id that never existed, so the lost race tells a prober nothing — · deciding a pending one is a 200 and the detail read then shows it rejected with its decision instant (the twin)`, async () => {
    // A namespace of its own: the shared world's pending approval is other rows' fixture.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "news" }] }],
      agents: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] }, tokens: [{ as: "agent" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const id = await openApproval(ns, "news");
    const csrf = bootstrapCsrfOf(await page(paths.approvals, session.cookie));
    const decide = (approvalId: string): Promise<Response> =>
      hub("POST", "/api/hub/ops/approval_decide", { id: approvalId, decision: "reject" }, {
        cookie: session.cookie,
        csrf,
      });

    // The twin first, because it is what makes the second decision a lost race.
    const decided = await decide(id);
    expect(decided.status, await decided.clone().text()).toBe(200);
    expect((await jsonOf(decided)).value).toEqual({ id, decision: "reject" });
    // And the detail read reports it the way the page draws it: `decided()` narrowing holds,
    // a rejected row carries the instant its decision was stamped.
    const read = await hub("GET", `/api/hub/approvals/${id}`, undefined, { cookie: session.cookie });
    const approval = (await jsonOf(read)).approval as Record<string, unknown>;
    expect(approval.status).toBe("rejected");
    expect(typeof approval.decidedAt).toBe("string");

    // The lost race: the same decision again, after the row stopped being pending.
    const lost = await decide(id);
    expect(lost.status).toBe(422);
    const lostBody = await lost.text();
    expect(typeof (JSON.parse(lostBody) as { reason?: unknown }).reason).toBe("string");
    const invented = await decide("apr_this-id-never-existed");
    expect(invented.status).toBe(422);
    expect(lostBody, "a lost race is distinguishable from an id that never existed").toBe(await invented.text());
  });

  it("§13 · the two form targets /approvals posted are gone (decision 38): every admin op named at POST /approvals/<op> — the generic dispatcher that admitted ANY op by name — reaches its handler zero times and answers no redirect, even carrying the session's own CSRF field, and POST /approvals/push stores no subscription; what the pages post now is the nine-name allowlist (row 18) and the push route below", async () => {
    const csrf = bootstrapCsrfOf(await page(paths.approvals));
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const name of Object.keys(ops)) {
        // Spelled literally on purpose: this is the path that must no longer route, so it
        // cannot come from `paths`.
        const gone = await post(`/approvals/${name}?id=${world.approvalId}`, { decision: "approve" }, { csrf });
        expect(gone.status, `POST /approvals/${name}`).toBe(404);
        expect(gone.headers.get("Location"), `POST /approvals/${name}`).toBeNull();
        expect(times(invocations, name), `POST /approvals/${name} reached ${name}`).toBe(0);
      }
    });
    const before = await pushRowsOf(world.ns.owner.userId);
    const push = await post(
      "/approvals/push",
      { subscription: JSON.stringify(pushSubscription(uniqueSlug("gone"))) },
      { csrf },
    );
    expect(push.status).toBe(404);
    expect(await pushRowsOf(world.ns.owner.userId)).toBe(before);
  });
});

describe("§13 · POST /api/hub/approvals/push — the browser's push subscription, through the write gate", () => {
  // The first route-level rows this subscription has ever had: the form target it replaces
  // had none, and approvals.test.ts covers `subscribePush` alone. A namespace of its own, so
  // "no row" and "exactly one row" are counts over an owner nothing else subscribes.
  let owner: { userId: string; cookie: string; csrf: string } | null = null;
  const subscriber = async (): Promise<{ userId: string; cookie: string; csrf: string }> => {
    if (owner !== null) return owner;
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    owner = {
      userId: ns.owner.userId,
      cookie: session.cookie,
      csrf: bootstrapCsrfOf(await page(paths.approvals, session.cookie)),
    };
    return owner;
  };

  it("§13 · a malformed subscription is 400 with a reason and stores no row — no subscription, the old form's JSON-string wire, a non-string endpoint, no keys, a missing auth key — · the well-formed twin is 204 and stores exactly one row, under this owner", async () => {
    const { userId, cookie, csrf } = await subscriber();
    const endpoint = `https://push.invalid/${uniqueSlug("sub")}`;
    const whole = pushSubscription(endpoint);
    for (const body of [
      {},
      { subscription: JSON.stringify(whole) },
      { subscription: { ...whole, endpoint: 7 } },
      { subscription: { endpoint } },
      { subscription: { endpoint, keys: { p256dh: whole.keys.p256dh } } },
    ]) {
      const refused = await hub("POST", "/api/hub/approvals/push", body, { cookie, csrf });
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(await reasonOf(refused), JSON.stringify(body)).not.toBe("");
      expect(await pushRowsOf(userId), JSON.stringify(body)).toBe(0);
    }

    const accepted = await hub("POST", "/api/hub/approvals/push", { subscription: whole }, { cookie, csrf });
    expect(accepted.status, await accepted.clone().text()).toBe(204);
    expect(await accepted.text()).toBe("");
    expect(await pushRowsOf(userId)).toBe(1);
    const stored = await (env.DB as D1Like)
      .prepare(`SELECT user_id, keys_json FROM push_subscription WHERE endpoint = ?`)
      .bind(endpoint)
      .first<{ user_id: string; keys_json: string }>();
    expect(stored?.user_id).toBe(userId);
    expect(JSON.parse(stored?.keys_json ?? "null")).toEqual(whole.keys);
  });

  it("§13 · without `X-Pmcp-Csrf` the subscription is 403 and stores nothing — a cross-site page cannot register its own endpoint for the owner's approval pushes · the same body with the session's token is 204 (the twin)", async () => {
    const { userId, cookie, csrf } = await subscriber();
    const body = { subscription: pushSubscription(`https://push.invalid/${uniqueSlug("nocsrf")}`) };
    const before = await pushRowsOf(userId);

    const refused = await hub("POST", "/api/hub/approvals/push", body, { cookie, origin: ORIGIN });
    expect(refused.status).toBe(403);
    expect(await reasonOf(refused)).toBe("Forbidden");
    expect(await pushRowsOf(userId)).toBe(before);

    const accepted = await hub("POST", "/api/hub/approvals/push", body, { cookie, csrf, origin: ORIGIN });
    expect(accepted.status).toBe(204);
    expect(await pushRowsOf(userId)).toBe(before + 1);
  });
});

/** A browser's `PushSubscription.toJSON()` in shape, with obviously fake keys: the route
 *  checks the shape and stores it, and nothing here sends a push to it. */
function pushSubscription(endpoint: string): { endpoint: string; keys: { p256dh: string; auth: string } } {
  return { endpoint, keys: { p256dh: "FAKE0000-p256dh", auth: "FAKE0000-auth" } };
}

/** How many push subscriptions one owner holds, read off the table the route writes. */
async function pushRowsOf(userId: string): Promise<number> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT COUNT(*) AS n FROM push_subscription WHERE user_id = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

describe("§8 · parity direction B — forms and schemas are one source", () => {
  // `/apps` left every walk in this describe with the SPA cutover (2026-09-18): it renders
  // no form, so a form walk over it can only ever find nothing. What replaces it is not a
  // second form walk but the surface that took the forms' place — `POST /api/hub/ops/:op`,
  // whose allowlist is the new answer to "what can a browser reach", checked below in both
  // directions with nothing transcribed that is not itself asserted.
  // 16 and 17 walked /approvals' forms — "every form names an ops key that exists" and "each
  // form's fields are schemaKeysOf(ops[name])". Retired with decision 38: /approvals is the
  // shell and renders no form. Where each guarantee went:
  //  - 16's "the page fronts only ops that exist" is 18 below — the allowlist the JSON
  //    surface admits, measured against `admin.ops` in both directions, and it admits
  //    `approval_decide`.
  //  - 17's SERVER half is 18b — `parseInput` refuses a body carrying a field the op does not
  //    declare, so a client body that drifted from the schema is a 422, not a silent drop.
  //    Its CLIENT half (the body Approve/Reject builds is `{ id, decision }`) is web-side.

  // 18 was "/settings renders no ops-backed form at all", true only while /settings was one
  // page. §13's Tokens and Connected clients panes front `token_revoke` and
  // `connection_revoke`, so the claim is now PER PANE and lives with the panes: see
  // "every control the /settings panes render is claimed".

  it("18. §8/§13 · the browser's generic op surface is an ALLOWLIST and nothing else: every name POST /api/hub/ops/:op admits reaches its ops handler exactly once, every other ops name answers byte-identically to a name that is not an op at all — so a probe cannot tell withheld from nonexistent — and the admitted set is exactly the nine names, asserted against what the router does rather than copied from it", async () => {
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    const notAnOp = uniqueSlug("no_such_op");
    // Every handler substituted, so an admitted name is measured by whether it ARRIVED
    // rather than by whether its arguments happened to parse — `{}` satisfies no real
    // schema, and a refusal there would classify a reachable op as withheld.
    const { admitted, answers, absent } = await withCountedOps([...Object.keys(ops)], async (invocations) => {
      const admitted: string[] = [];
      const answers = new Map<string, string>();
      for (const name of Object.keys(ops)) {
        const answered = await hub("POST", `/api/hub/ops/${name}`, {}, { csrf });
        answers.set(name, `${answered.status} ${await answered.text()}`);
        if (answered.status === 404) {
          expect(times(invocations, name), `withheld ${name} still reached its handler`).toBe(0);
          continue;
        }
        expect(answered.status, `POST /api/hub/ops/${name}`).toBe(200);
        expect(times(invocations, name), `admitted ${name} did not reach its handler`).toBe(1);
        admitted.push(name);
      }
      const outside = await hub("POST", `/api/hub/ops/${notAnOp}`, {}, { csrf });
      return { admitted, answers, absent: `${outside.status} ${await outside.text()}` };
    });

    // DIRECTION ONE: what is withheld is indistinguishable from what does not exist. Status
    // and body bytes both, because a distinguishable refusal is exactly the leak.
    expect(absent.startsWith("404 "), `a name outside ops answered "${absent}"`).toBe(true);
    for (const [name, answered] of answers) {
      if (admitted.includes(name)) continue;
      expect(answered, `withheld "${name}" is distinguishable from "${notAnOp}"`).toBe(absent);
    }

    // DIRECTION TWO: the set the router admits IS the nine §13 names. The list is spelled
    // here only so a reader can see it — what the row asserts is that it equals the set
    // measured above, so adding a tenth name to the allowlist reddens this row rather than
    // riding in unnoticed, and removing one does too.
    expect(admitted.sort()).toEqual(
      [
        "agent_create",
        "agent_delete",
        "app_archive",
        "app_delete",
        "app_disconnect",
        "app_unarchive",
        "approval_decide",
        "token_issue",
        "token_revoke",
      ],
    );
  });

  it("18b. §8 · an admitted op still answers to its own schema: a body carrying a field the tool does not declare is refused 422 with the reason, not accepted and not silently dropped — `parseInput` is the authority the JSON surface hands the body straight to", async () => {
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    const refused = await hub(
      "POST",
      "/api/hub/ops/app_archive",
      { slug: "news", nonesuch: "1" },
      { csrf },
    );
    expect(refused.status).toBe(422);
    expect(await reasonOf(refused)).toContain("does not declare");
    // And nothing was written: the app the body named is still unarchived, read off the
    // store rather than off the answer that just refused.
    const row = await new Registry(env.DB).getApp(world.ns.owner.userId, "news");
    expect(row?.archived ?? true).toBe(false);
  });

  it("19. §8 · every page mutation reaches an ops handler (or better-auth): no route a moved page writes through mutates D1 on its own — the no-web-only-capability invariant, checked by substituting handlers across the ops table rather than by reading web.ts or api.ts", async () => {
    // Ported with decision 38. The walk used to DISCOVER its targets in /approvals' rendered
    // forms; the moved pages render none, so the ops-backed JSON writes they make are listed
    // instead — each family adds its own as it moves (family 2: token_revoke,
    // connection_revoke, hub_settings_update). The token is read first, while the ops table
    // is still real: the substitution below replaces the read handlers too.
    const writes: { op: string; path: string; body: Record<string, unknown> }[] = [
      {
        op: "approval_decide",
        path: "/api/hub/ops/approval_decide",
        body: { id: world.approvalId, decision: "approve" },
      },
    ];
    const csrf = bootstrapCsrfOf(await page(paths.apps));
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      const before = await namespaceShape();
      for (const { op, path, body } of writes) {
        const answered = await hub("POST", path, body, { csrf });
        expect(answered.status, `POST ${path}`).toBe(200);
        expect(times(invocations, op), `POST ${path} reached ${op}`).toBe(1);
        expect(invocations.get(op)?.[0], `POST ${path} handed ${op} its body`).toEqual(body);
      }
      // Substituted handlers changed nothing, so if the route layer had written to D1 on
      // its own the namespace would have moved anyway. It did not.
      expect(await namespaceShape()).toEqual(before);
    });
  });
});

describe("§7/§13 · the OAuth callback shell", () => {
  it("20. §7 · /oauth/upstream/callback without an owner session is refused before any upstream code runs and stores nothing · with the session and a live single-use state it completes (the twin; every other state failure is upstream-credentials.test.ts's table)", async () => {
    const started = await beginConnect(world.oauth.app, { id: world.sessionId });
    const redirected = await fetch(started.toString(), { redirect: "manual" });
    const callbackUrl = redirected.headers.get("Location");
    expect(callbackUrl, "the fake AS answered no redirect").not.toBeNull();
    const state = started.searchParams.get("state") ?? "";

    const anonymous = await call(new Request(callbackUrl ?? ""));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("Location")).toMatch(/^\/login(\?|$)/);
    // Nothing ran and nothing was stored: the single-use state is still unconsumed and
    // the app still holds no credential.
    expect(await stateRows(state)).toBe(1);
    expect(await connectionOf("notion")).toBe("not_connected");

    // The twin: the same callback, the owner's browser session.
    const completed = await call(
      new Request(callbackUrl ?? "", { headers: { Cookie: world.session.cookie } }),
    );
    expect(completed.status).toBe(302);
    // §13 (37(b)): a finished Connect lands on the app's own page carrying the notice.
    const landed = new URL(completed.headers.get("Location") ?? "", ORIGIN);
    expect(landed.pathname).toBe(paths.appPane("notion", "overview"));
    expect(landed.searchParams.get("done")).toBe("connect");
    expect(await stateRows(state)).toBe(0);
    expect(await connectionOf("notion")).toBe("connected");
  });
});

describe("§4/§13 · the credential forms speak the browser's content type", () => {
  /** The owner these cases sign in as. Their own namespace, so a sign-in, a failed
   *  attempt or a revoked session cannot move any other case's world. */
  let signer: SeededNamespace;

  beforeAll(async () => {
    signer = await seedNamespace(env.DB, {});
    await seedOwnerCredential(signer.owner.userId);
  });

  it("21. §13 · /login's own sign-in form, submitted as a browser submits it (application/x-www-form-urlencoded), lands a session cookie and a redirect — better-auth's endpoints allow application/json only, so a form posted straight at one answers 415 and no human ever signs in", async () => {
    const action = actionFor(await anonymousPage(paths.login), "username");
    const answered = await formPost(action, {
      username: signer.owner.username,
      password: SEEDED_OWNER_PASSWORD,
      // Deliberately NOT the default landing page: /apps is also where a missing or
      // refused callbackURL falls back to, so asserting it would pass either way. This is
      // the deep link /login carries through the round trip (LoginProps.redirectTo).
      callbackURL: paths.audit,
    });
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(paths.audit);
    const cookie = sessionCookieOf(answered);
    expect(cookie, "the sign-in set no session cookie").not.toBeNull();
    // The cookie is a real session, not merely a header: it opens a page that requires one.
    const opened = await get(paths.apps, cookie ?? "");
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain(signer.owner.username);
  });

  it("22. §15 · a wrong password re-renders /login with its field error and NO session cookie (the refusal twin of 21) — and the password appears in neither the redirect nor the page", async () => {
    const action = actionFor(await anonymousPage(paths.login), "username");
    const wrong = "FAKE0000-not-the-seeded-password";
    const answered = await formPost(action, {
      username: signer.owner.username,
      password: wrong,
      callbackURL: paths.apps,
    });
    expect(answered.status).toBe(303);
    const to = answered.headers.get("Location") ?? "";
    expect(to.startsWith(paths.login)).toBe(true);
    expect(sessionCookieOf(answered)).toBeNull();
    expect(to).not.toContain(wrong);
    const rerendered = await anonymousPage(to);
    // The credentials card, redrawn with its error and the username echoed back so only
    // the password is retyped (LoginStep's "credentials" arm).
    expect(rerendered).toContain("field-error");
    expect(rerendered).toContain(signer.owner.username);
    expect(rerendered).not.toContain(wrong);
  });

  it("23. §4 · the TOTP and backup-code challenge forms are translated too: each posts form-encoded to a hub route that answers a redirect back to its own /login step, never better-auth's 415", async () => {
    for (const [step, op] of [
      ["totp", "verify-totp"],
      ["backup-code", "verify-backup-code"],
    ] as const) {
      const action = actionFor(await anonymousPage(`${paths.login}?step=${step}`), op);
      const answered = await formPost(action, { code: "000000", callbackURL: paths.apps });
      expect(answered.status, `POST ${action}`).toBe(303);
      // No challenge is pending, so this is the refusal leg: back to the same card, with a
      // message and without a session.
      const to = answered.headers.get("Location") ?? "";
      expect(to).toContain(`step=${step}`);
      expect(sessionCookieOf(answered)).toBeNull();
    }
  });

  it("24. §13 · every credential form the pages render posts to a route this worker serves as a form — walked out of the rendered HTML, so a target that would answer 415 or 404 cannot be rendered", async () => {
    // A NAMESPACE of this case's own, not merely a session: `sign-out` and
    // `revoke-other-sessions` are both walked targets, and the second succeeds — it would
    // end every other session of whichever owner it rides, the fixture's included.
    const walker = await seedOwnerSession((await seedNamespace(env.DB, {})).owner);
    const targets = new Map<string, Record<string, string>>();
    for (const html of await credentialPages(walker.cookie)) {
      for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
        if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
        const action = decodeEntities(attributeOf(form[1], "action") ?? "");
        const op = action.split("?")[0].split("/").filter(Boolean).pop() ?? "";
        if (!BETTER_AUTH_ACTIONS.has(op)) continue;
        targets.set(action, submissionOf(form[2]));
      }
    }
    expect(targets.size, "no credential form was rendered to walk").toBeGreaterThan(0);
    // The session-ending targets last, for the reason above.
    const walk = [...targets].sort(([a], [b]) => Number(ENDS_SESSIONS(a)) - Number(ENDS_SESSIONS(b)));
    for (const [action, fields] of walk) {
      const answered = await formPost(action, fields, walker.cookie);
      expect(answered.status, `POST ${action}`).not.toBe(415);
      expect(answered.status, `POST ${action}`).not.toBe(404);
      expect(answered.status, `POST ${action}`).toBeLessThan(500);
    }
  });

  it("24a. §13 · the SPA's Sign out — the one form the React shell renders, which 24's walk of server HTML cannot see — posts where this worker translates it: a control-less form body answers 303 to /login and ends the session, never better-auth's 415 JSON (it did, from the SPA's first ship until 2026-09-23)", async () => {
    const leaver = await seedOwnerSession((await seedNamespace(env.DB, {})).owner);
    expect(webPaths.signOut, "the SPA's form must target the translating route").toBe(paths.auth.signOut);
    // Exactly what the browser sends for `<form method="post">` with a lone submit button.
    const answered = await formPost(webPaths.signOut, {}, leaver.cookie);
    expect(answered.status, await answered.clone().text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(paths.login);
    // Ended, not merely redirected: the cookie no longer opens a signed-in page.
    const after = await get(paths.apps, leaver.cookie);
    expect(after.status).toBe(302);
  });

  // 25, 25a and 26 moved to the panes that own their journeys: the Sessions pane's Revoke,
  // the Passkeys pane's Remove, and the /settings POST-prefix walk, all below.

  it("27. §4/§13 · /settings's Enable two-factor and Regenerate backup codes render the password control the credential seam reads — each form, filled and submitted exactly as the page drew it, is ACCEPTED by better-auth instead of refused for a field no browser could send", async () => {
    const owner = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(owner.owner);

    // Not enrolled, so the two-factor card draws its enable form and nothing else.
    const enable = formsPostingTo(await page(paths.settingsTwoFactor, session.cookie), paths.auth.totpEnable);
    expect(enable.length, "/settings/two-factor rendered no Enable two-factor form").toBeGreaterThan(0);
    for (const form of enable) {
      const answered = await formPost(
        paths.auth.totpEnable,
        typedInto(form, { password: SEEDED_OWNER_PASSWORD }),
        session.cookie,
      );
      // 200, not a redirect: better-auth accepted the password this form carried and its
      // answer IS the page (the enrolment card in place — a secret cannot ride a URL, §15).
      // The refusal leg is the POST-prefix walk's, where a wrong password comes back 303
      // with `failed=`.
      expect(answered.status).toBe(200);
      expect(await answered.text(), "the 200 rendered no enrolment").toContain("data:image/svg+xml");
    }

    // The enable above created the two-factor row; this makes it live, which is the only
    // state in which the page draws its backup-code control at all.
    await enrollTwoFactor(owner.owner.userId);
    const regenerate = formsPostingTo(
      await page(paths.settingsTwoFactor, session.cookie),
      paths.auth.backupCodesGenerate,
    );
    expect(regenerate.length, "/settings/two-factor rendered no Regenerate backup codes form").toBeGreaterThan(0);
    for (const form of regenerate) {
      const answered = await formPost(
        paths.auth.backupCodesGenerate,
        typedInto(form, { password: SEEDED_OWNER_PASSWORD }),
        session.cookie,
      );
      // Accepted, and the fresh set is revealed in place for the same reason.
      expect(answered.status).toBe(200);
      expect(await answered.text(), "the 200 revealed no codes").toContain("data-code");
    }
  });
});

describe("§4/§13/§15/§19.5 · /login's landing — one relative-only rule for both consumers", () => {
  // The landing has TWO consumers — the inline passkey script's LANDING literal and the
  // hidden callbackURL the three cards post — so a row about the rule pins both, and only
  // a row about one consumer's own spelling names one.

  /** The passkey script's landing, as the LITERAL the page embedded — quotes included, so
   *  a row can ask what the ESCAPING did before asking what the value is. */
  function landingLiteralOf(html: string): string {
    const literal = /var LANDING = ("[^"]*");/.exec(html)?.[1];
    expect(literal, "the page embedded no LANDING literal").not.toBeUndefined();
    return literal ?? "";
  }

  /** The hidden callbackURL, as the RAW attribute text — same reason. */
  function callbackLiteralOf(html: string): string {
    const value = /name="callbackURL"\s+value="([^"]*)"/.exec(html)?.[1];
    expect(value, "the page rendered no callbackURL field").not.toBeUndefined();
    return value ?? "";
  }

  /** The href of the card's "use the other method" link, as a browser would follow it. */
  function switchHrefOf(html: string, method: "totp" | "backup-code"): string {
    const href = new RegExp(`<a href="([^"]*method=${method}[^"]*)"`).exec(html)?.[1];
    expect(href, `the card rendered no ${method} switch link`).not.toBeUndefined();
    return decodeEntities(href ?? "");
  }

  /** An attribute value back to the string the renderer was given. The file's
   *  `decodeEntities` undoes `&amp;` alone, which is all a URL ever needs; these rows read
   *  MARKUP back out of an attribute, so they undo the two escapes that markup earns.
   *  `&amp;` last, so an escaped `&lt;` in the input is not decoded twice. */
  function unescapeAttribute(raw: string): string {
    return raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }

  /** A `?next=` deep link's own owner: signing in is what the posted arm below does, and
   *  the file's world owner is shared with cases that could leave a two-factor challenge
   *  in front of a password (a sign-in that answers `twoFactorRedirect` lands on /login,
   *  not on the landing, and would prove nothing about `landingOf`). */
  let signer: SeededNamespace;

  beforeAll(async () => {
    signer = await seedNamespace(env.DB, {});
    await seedOwnerCredential(signer.owner.userId);
  });

  it(
    `§15 · a hub-relative ?next=/apps%3C/script%3E%3Cimg src=x onerror=…%3E%E2%80%A8 reaches both embeds and is escaped in both — the inline script's LANDING carries no raw "<" and no raw U+2028 line separator, and the hidden callbackURL carries &lt;, so "</script><img" appears nowhere in the document — while ?next=/settings/tokens reaches the same two verbatim (the twin)`,
    async () => {
      // The payload PASSES the hub-relative rule on purpose — it starts "/a" — so it
      // reaches both embeds. Escaping, not refusal, is what this row is about.
      const payload = "/apps</script><img src=x onerror=alert(1)>\u2028";
      const html = await anonymousPage(`${paths.login}?next=${encodeURIComponent(payload)}`);
      expect(html).not.toContain("</script><img");
      expect(html).not.toContain("<img src=x");

      const landing = landingLiteralOf(html);
      expect(landing).not.toContain("<");
      expect(landing).not.toContain("\u2028");
      // Escaped, not truncated: the literal still evaluates to exactly what arrived.
      expect(JSON.parse(landing) as string).toBe(payload);

      const callback = callbackLiteralOf(html);
      expect(callback).toContain("&lt;/script&gt;");
      expect(unescapeAttribute(callback)).toBe(payload);

      // The twin: a relative deep link reaches the same two consumers byte for byte, so
      // the escape above is an escape and not a fallback wearing one's clothes.
      const clean = await anonymousPage(`${paths.login}?next=${encodeURIComponent(paths.settingsTokens)}`);
      expect(JSON.parse(landingLiteralOf(clean)) as string).toBe(paths.settingsTokens);
      expect(unescapeAttribute(callbackLiteralOf(clean))).toBe(paths.settingsTokens);
    },
  );

  // plan row 2. The posted arm names TWO spellings deliberately: an absolute callbackURL
  // already lands on /apps under today's `landingOf` (it fails `startsWith("/")`), so the
  // backslash spelling is the leg that fails until `hubRelative` lands — without it no row
  // here gates the posted consumer's half of the fix.
  it(
    `§4 · ?next=https://evil.example, ?next=//evil.example, ?next=/%5Cevil.example (the backslash spelling a browser folds into //) and an empty ?next= each land on /apps in BOTH consumers — the script's LANDING and the hidden callbackURL — and a sign-in POST carrying an absolute callbackURL, or that same backslash spelling which today's two-branch test lets through, redirects to /apps too (the posted twin, one rule)`,
    async () => {
      for (const hostile of ["https://evil.example", "//evil.example", "/\\evil.example", ""]) {
        const html = await anonymousPage(`${paths.login}?next=${encodeURIComponent(hostile)}`);
        expect(JSON.parse(landingLiteralOf(html)) as string, hostile).toBe(paths.apps);
        expect(unescapeAttribute(callbackLiteralOf(html)), hostile).toBe(paths.apps);
        // Not merely "not honoured": the string reaches no embed of the document at all.
        expect(html, hostile).not.toContain("evil.example");
      }

      // The posted twin. The password is the RIGHT one deliberately — a refusal redirects
      // to /login whatever the callbackURL said, and would pin nothing about `landingOf`.
      for (const hostile of ["https://evil.example/hijack", "/\\evil.example/hijack"]) {
        const action = actionFor(await anonymousPage(paths.login), "username");
        const answered = await formPost(action, {
          username: signer.owner.username,
          password: SEEDED_OWNER_PASSWORD,
          callbackURL: hostile,
        });
        expect(answered.status, await answered.text()).toBe(303);
        expect(answered.headers.get("Location"), hostile).toBe(paths.apps);
        // A refusal wearing a 303: the sign-in itself has to have succeeded.
        expect(sessionCookieOf(answered), hostile).not.toBeNull();
      }
    },
  );

  it(
    `§13 · a TOTP challenge reached as /login?step=totp&next=/settings/tokens links "Use a backup code instead" to /login?method=backup-code&next=%2Fsettings%2Ftokens, and the backup-code card it opens carries callbackURL=/settings/tokens — with no next= the switch links carry none and the card lands on /apps (the twin)`,
    async () => {
      const totp = await anonymousPage(
        `${paths.login}?step=totp&next=${encodeURIComponent(paths.settingsTokens)}`,
      );
      const href = switchHrefOf(totp, "backup-code");
      const switched = new URL(href, ORIGIN);
      expect(switched.pathname).toBe(paths.login);
      expect(switched.searchParams.get("method")).toBe("backup-code");
      expect(switched.searchParams.get("next")).toBe(paths.settingsTokens);
      // The encoded spelling the title names — a switch link a browser can follow.
      expect(href).toContain("next=%2Fsettings%2Ftokens");

      // Followed as a browser follows it: the card it opens posts the same landing.
      const backup = await anonymousPage(href);
      expect(unescapeAttribute(callbackLiteralOf(backup))).toBe(paths.settingsTokens);
      // And the way back carries it too, so a round trip between the two cards is lossless.
      expect(new URL(switchHrefOf(backup, "totp"), ORIGIN).searchParams.get("next")).toBe(
        paths.settingsTokens,
      );

      // The twin: with no deep link there is nothing to carry, and `loginUrl` drops an
      // empty field rather than spelling it — so the link is bare and the card lands on /apps.
      const bare = await anonymousPage(`${paths.login}?step=totp`);
      const bareHref = switchHrefOf(bare, "backup-code");
      expect(bareHref).toBe(`${paths.login}?method=backup-code`);
      expect(unescapeAttribute(callbackLiteralOf(await anonymousPage(bareHref)))).toBe(paths.apps);
    },
  );

  it(
    `§19.5 · a switch made from the signed-authorize arm keeps the /oauth2/authorize landing byte for byte, pinned at both ends: the TOTP card's backup-code link carries inside next= the very landing that card itself posts as callbackURL, and the card the link opens renders that same string as its own callbackURL, sig and client_id intact`,
    async () => {
      const { clientId } = await registerOAuthClient();
      const authorized = await call(new Request(authorizeUrl(clientId)));
      expect(authorized.status).toBe(302);
      const location = authorized.headers.get("Location") ?? "";
      expect(location).toMatch(/^\/login\?/);

      // The challenge card, reached on that same signed query.
      const totp = await anonymousPage(`${location}&step=totp`);
      const posted = unescapeAttribute(callbackLiteralOf(totp));
      const href = switchHrefOf(totp, "backup-code");
      const carried = new URL(href, ORIGIN).searchParams.get("next") ?? "";
      expect(carried.startsWith(`${paths.auth.base}/oauth2/authorize?`)).toBe(true);
      expect(carried).toContain(`client_id=${clientId}`);
      expect(carried).toContain("sig=");
      // End one: the link carries the landing the card it sits on was about to post.
      expect(carried).toBe(posted);

      // End two: the card the link opens posts that same string. One equality is the whole
      // round trip — `loginUrl` encoded it, `loginProps` decoded it, and `hubRelative` let
      // it through because it starts "/api/…".
      const backup = await anonymousPage(href);
      expect(unescapeAttribute(callbackLiteralOf(backup))).toBe(carried);
      // The signed pair rides INSIDE next=, never on /login's own query, which is why the
      // switched URL does not re-trigger the authorize arm and land back on itself.
      expect(new URL(href, ORIGIN).searchParams.has("sig")).toBe(false);
    },
  );

  // plan row 5, with the 404 on the NO-header side of the twin — a deviation from § Rows,
  // which lists it among the carriers. § Settled puts the header on `render` (web.ts:1283,
  // the tree's only text/html site); every 404 here is `noSuchPage()`, text/plain, built
  // without `render`. On the twin's side the 404 earns its keep: it proves the header
  // rides the page renderer rather than a blanket middleware.
  it(
    `§13 · one renderer emits every HTML page, so every one carries Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" and Cache-Control: no-store — checked on the three shapes: /login anonymous, /apps shelled under the owner's cookie, /apps/new chromeless — and on the shell at /approvals and /approvals/<id> (decision 38: a page that moved into the client keeps its anti-framing header) — while the hub's non-HTML answers, /styles.css and the surface's 404, carry neither (the twin; no-store added 2026-09-03)`,
    async () => {
      const CSP = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'";
      // Each page family joins this list as it becomes the shell (decision 38), until all
      // six URLs are carriers.
      const carriers = [
        await call(new Request(`${ORIGIN}${paths.login}`)),
        await get(paths.apps),
        await get(paths.appNew),
        await get(paths.approvals),
        await get(paths.approval(world.approvalId)),
      ];
      for (const carrier of carriers) {
        expect(carrier.status).toBe(200);
        expect(carrier.headers.get("Content-Type")).toContain("text/html");
        expect(carrier.headers.get("Content-Security-Policy")).toBe(CSP);
        // Every page is a function of the session (or of /login's challenge cookie): no
        // browser or intermediary may keep a copy to re-show (2026-09-03).
        expect(carrier.headers.get("Cache-Control")).toBe("no-store");
      }

      // The twin, and the reason it is worth having: these two prove the headers ride the
      // PAGE renderer rather than a blanket middleware over every response — the shell's
      // static assets stay cacheable.
      const css = await call(new Request(`${ORIGIN}${paths.stylesheet}`));
      expect(css.status).toBe(200);
      expect(css.headers.get("Content-Type")).toContain("text/css");
      expect(css.headers.get("Content-Security-Policy")).toBeNull();
      expect(css.headers.get("Cache-Control")).not.toBe("no-store");

      const missing = await get(`${paths.appDetail("catalog")}/tools`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("Content-Type")).toContain("text/plain");
      expect(missing.headers.get("Content-Security-Policy")).toBeNull();
      expect(missing.headers.get("Cache-Control")).toBeNull();
    },
  );

  // plan row 6. The strip is the RULE's own work, not the platform's: nothing on this path
  // runs a URL parser over `?next=`, so the fact that a browser reads `/<TAB>/evil.example`
  // as `//evil.example` is one the rule has to reproduce for itself. Only a row that spells
  // the three characters out keeps that strip from being read as decoration and deleted.
  it(
    `§4 · ?next=/%09/evil.example, /%0A/evil.example, /%0D/evil.example and /%09%5Cevil.example each land on /apps in BOTH consumers, because the rule strips what a browser's URL parser strips before judging — while a hub-relative ?next=/settings/%09tokens reaches both with only the tab gone (/settings/tokens), and a sign-in POST whose callbackURL is /%09/evil.example redirects to /apps (the posted twin)`,
    async () => {
      // Each of these starts "/" and its second character is neither "/" nor "\" — they
      // pass the rule UNSTRIPPED, and are refused only because the strip runs first.
      for (const hostile of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\t\\evil.example"]) {
        const html = await anonymousPage(`${paths.login}?next=${encodeURIComponent(hostile)}`);
        expect(JSON.parse(landingLiteralOf(html)) as string, hostile).toBe(paths.apps);
        expect(unescapeAttribute(callbackLiteralOf(html)), hostile).toBe(paths.apps);
        expect(html, hostile).not.toContain("evil.example");
      }

      // The twin: the same three characters inside a landing that stays hub-relative are
      // removed and nothing else is — a strip, not a refusal, and not a pass-through.
      const carried = await anonymousPage(`${paths.login}?next=${encodeURIComponent("/settings/\ttokens")}`);
      expect(JSON.parse(landingLiteralOf(carried)) as string).toBe(paths.settingsTokens);
      expect(unescapeAttribute(callbackLiteralOf(carried))).toBe(paths.settingsTokens);

      // The posted twin, with the tab as the raw character a browser would send. Right
      // password on purpose: a refusal redirects to /login whatever the callbackURL said.
      const action = actionFor(await anonymousPage(paths.login), "username");
      const answered = await formPost(action, {
        username: signer.owner.username,
        password: SEEDED_OWNER_PASSWORD,
        callbackURL: "/\t/evil.example",
      });
      expect(answered.status, await answered.text()).toBe(303);
      expect(answered.headers.get("Location")).toBe(paths.apps);
      expect(sessionCookieOf(answered)).not.toBeNull();
    },
  );
});

describe("§13 · the device decision, submitted the way the owner submits it", () => {
  // The debt `BROWSER_ONLY_TARGETS` owes for excluding "decide" from the parity walks (§9
  // rule 4a): this form fronts no op, so cases 16/17 cannot describe it and cases 28/29
  // walk it end to end instead. Both legs run the WHOLE flow — the CLI's code request, the
  // owner's page render (which is what CLAIMS the code), the form post, and the CLI's
  // redemption — because the decision is only observable at the far end of it.

  it("28. §13 · /device's Approve button, posted form-encoded to the action the page rendered, decides the code: the redirect says approved and the CLI's redemption mints a session that /api/whoami answers as the owner", async () => {
    const codes = await requestDeviceCodes();
    const rendered = await page(`${paths.device}?user_code=${encodeURIComponent(codes.userCode)}`);
    const submission = clickedSubmission(rendered, "approve");
    // The target the page named, not one this case spelled (§9 rule 4b).
    expect(submission.action).toBe(paths.deviceDecide);
    // The hidden controls a browser would carry: the page's own CSRF token and the code
    // being decided. Without them this POST is a cross-site post, and case 1's gate answers.
    expect(Object.keys(submission.fields)).toContain("csrf");
    expect(submission.fields.user_code).toBe(codes.userCode);

    const answered = await formPost(submission.action, submission.fields, world.session.cookie);
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(`${paths.device}?decided=approved`);

    // The far end of the flow: the CLI redeems the code it was issued and gets a real
    // session — the thing §13 warns the owner they are handing over.
    const redeemed = await redeemDeviceCode(codes.deviceCode);
    expect(redeemed.error, "the approved code was refused at redemption").toBeUndefined();
    expect(typeof redeemed.access_token).toBe("string");
    const whoami = await call(
      new Request(`${ORIGIN}/api/whoami`, {
        headers: { Authorization: `Bearer ${redeemed.access_token ?? ""}` },
      }),
    );
    expect(whoami.status).toBe(200);
    expect(await whoami.json()).toMatchObject({ principal: `user:${world.ns.owner.username}` });
  });

  it("29. §13 · the Deny button on the same rendered form ends the flow the other way — the redirect says denied and the CLI's redemption is refused access_denied with no token (the twin of 28: one form, one gate, two outcomes)", async () => {
    const codes = await requestDeviceCodes();
    const rendered = await page(`${paths.device}?user_code=${encodeURIComponent(codes.userCode)}`);
    const submission = clickedSubmission(rendered, "deny");
    expect(submission.action).toBe(paths.deviceDecide);

    const answered = await formPost(submission.action, submission.fields, world.session.cookie);
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(`${paths.device}?decided=denied`);

    const redeemed = await redeemDeviceCode(codes.deviceCode);
    expect(redeemed.access_token, "a denied code still minted a session").toBeUndefined();
    expect(redeemed.error).toBe("access_denied");
  });
});

describe("§15 · the two auth events the ledger records", () => {
  it("30. §15 · a real sign-in through /login's own form writes exactly one auth.login row, attributed to the user who signed in — and the row carries no body, no token material and nothing the form submitted", async () => {
    // An owner of this case's own, never signed in before: `seedNamespace` provisions the
    // row and `seedOwnerCredential` gives it a password, and neither is a login — so the
    // count below is this sign-in and nothing else.
    const owner = await seedNamespace(env.DB, {});
    await seedOwnerCredential(owner.owner.userId);
    const answered = await formPost(actionFor(await anonymousPage(paths.login), "username"), {
      username: owner.owner.username,
      password: SEEDED_OWNER_PASSWORD,
      callbackURL: paths.apps,
    });
    expect(answered.status, await answered.text()).toBe(303);
    const cookie = sessionCookieOf(answered);
    expect(cookie, "the sign-in set no session cookie").not.toBeNull();

    const recorded = await query(env.DB, owner.owner.userId, { event: "auth.login" });
    expect(recorded.total, "the sign-in wrote no auth.login row").toBe(1);
    expect(recorded.rows[0]).toMatchObject({
      event: "auth.login",
      principal: `user:${owner.owner.username}`,
      outcome: "ok",
    });
    // The session token the sign-in just minted, and the password that bought it: neither
    // belongs in the ledger, and both were in the request that produced this row.
    hygienic(recorded.rows[0], [SEEDED_OWNER_PASSWORD, (cookie ?? "").split("=")[1] ?? ""]);
  });

  it("31. §15 · approving a device through /device's own form writes exactly one auth.device_approved row, attributed to the browser session that approved it — and the row holds neither the codes nor the session it minted", async () => {
    const owner = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(owner.owner);
    const codes = await requestDeviceCodes();
    const rendered = await page(
      `${paths.device}?user_code=${encodeURIComponent(codes.userCode)}`,
      session.cookie,
    );
    const submission = clickedSubmission(rendered, "approve");
    const answered = await formPost(submission.action, submission.fields, session.cookie);
    expect(answered.status, await answered.text()).toBe(303);
    const minted = await redeemDeviceCode(codes.deviceCode);
    expect(typeof minted.access_token).toBe("string");

    const recorded = await query(env.DB, owner.owner.userId, { event: "auth.device_approved" });
    expect(recorded.total, "the approval wrote no auth.device_approved row").toBe(1);
    expect(recorded.rows[0]).toMatchObject({
      event: "auth.device_approved",
      principal: `user:${owner.owner.username}`,
      outcome: "ok",
    });
    hygienic(recorded.rows[0], [codes.deviceCode, codes.userCode, minted.access_token ?? ""]);
  });
});

describe(`§13 · the PWA icons — the install gate's own bytes`, () => {
  // Rows first (§9 rule 1): the manifest lists no icons at all today, so all three are red on
  // the whole of G6 — the bytes, the entries that declare them, and the head that links them.

  // plan row 1. The bytes, walked out of the manifest rather than transcribed: each entry's
  // own src must answer with a PNG whose signature and IHDR width are the size that entry
  // declares, which is what a constant pasted under the wrong entry — or a bundler handing
  // back a path string — fails. A spelling ROUTES does not serve is the 404 twin. `icons` is
  // `[]` today, so the walk is vacuous until the body opens on the length of the pair row 2
  // names — without that line this row goes green against the very gap it closes.
  it(`§13 · every icons[] src the manifest lists answers 200 through worker.fetch with no cookie, Content-Type image/png, and a body whose PNG signature and IHDR width are the size its entry declares — so a constant pasted under the wrong entry, or a bundler handing back a path string where bytes belong, reddens here — while /icon-256.png, a spelling ROUTES does not serve, is no segment at all and comes back on the hub's one anonymous 404 (the twin)`, async () => {
    const manifest = (await (await call(new Request(`${ORIGIN}${paths.manifest}`))).json()) as {
      icons: { src: string; sizes: string }[];
    };
    // The walk below is vacuous over an empty array, which is exactly the gap this closes.
    expect(manifest.icons).toHaveLength(2);
    for (const icon of manifest.icons) {
      const answered = await call(new Request(`${ORIGIN}${icon.src}`));
      expect(answered.status, icon.src).toBe(200);
      expect(answered.headers.get("Content-Type"), icon.src).toBe("image/png");
      const bytes = new Uint8Array(await answered.arrayBuffer());
      // The PNG signature, then IHDR's width at byte 16 (big-endian) — the size the entry
      // declares, read off the bytes rather than trusted from the declaration.
      expect([...bytes.subarray(0, 8)], `${icon.src} signature`).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const width = new DataView(bytes.buffer).getUint32(16);
      expect(`${width}x${width}`, icon.src).toBe(icon.sizes);
    }
    // The twin: a spelling ROUTES does not serve is no segment — the same anonymous 404 as
    // any unclaimed top-level path, not an icon route answering for a size it lacks.
    const missing = await call(new Request(`${ORIGIN}/icon-256.png`));
    const unclaimed = await call(new Request(`${ORIGIN}/no-such-segment-${uniqueSlug("x")}`));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe(await unclaimed.text());
  });

  // plan row 2. The declaration rather than the bytes: exactly the 192/512 pair the install
  // gate is built around, beside the members that already satisfied the rest of it — and the
  // two spellings this step refuses to write, sizes "any" and any purpose at all, as the twin
  // that keeps a later hand from adding either.
  it(`§13 · the icons array carries exactly the pair §13's install gate is built around, 192x192 and 512x512, beside the name, start_url, scope and display that already satisfied the rest of it — while no entry declares sizes "any" (the Android WebAPK install failure chromium issue 40925759 reports) and none declares a purpose at all, the two spellings this step refuses to write (the twin)`, async () => {
    const manifest = (await (await call(new Request(`${ORIGIN}${paths.manifest}`))).json()) as Record<string, unknown> & {
      icons: Record<string, unknown>[];
    };
    expect(manifest.name).toBe("personal-mcps");
    expect(manifest.start_url).toBe(paths.apps);
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(["192x192", "512x512"]);
    expect(manifest.icons.map((icon) => icon.src)).toEqual([paths.icon192, paths.icon512]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe("image/png");
      expect(icon.sizes).not.toBe("any");
      expect(icon).not.toHaveProperty("purpose");
    }
  });

  // plan row 3. The one place this file names markup, and the header says why: the rel token
  // IS the browser contract. /apps draws both links at paths.icon192, the row importing paths
  // so the URL is never a literal on this side — /login's own head, which links neither, is
  // the ceiling the fix keeps and the twin.
  it(`§13 · the shell head links the icon the worker serves — /apps renders rel="icon" and rel="apple-touch-icon" at paths.icon192 beside the manifest link, the row importing paths while layout.tsx spells the URL itself as the other three assets already do — while /login's head, one of the five page files that write their own, links neither, the ceiling this fix keeps deliberately (the twin)`, async () => {
    const shell = await page(paths.apps);
    expect(shell).toContain(`<link rel="manifest" href="${paths.manifest}"`);
    expect(shell).toContain(`<link rel="icon" href="${paths.icon192}"`);
    expect(shell).toContain(`<link rel="apple-touch-icon" href="${paths.icon192}"`);
    // The twin: a page that writes its own head links no icon — kept, not forgotten.
    const login = await anonymousPage(paths.login);
    expect(login).not.toContain('rel="icon"');
    expect(login).not.toContain('rel="apple-touch-icon"');
  });
});

describe("§19.5 · the consent screen", () => {
  it("§19.5 · GET /oauth/consent without a cookie session bounces to /login carrying the signed oauth_query", async () => {
    // A shape a real signed query has (client_id + sig + exp) is enough to prove the
    // session gate fires first and carries the WHOLE thing through — the gate itself
    // (identity.requireOwnerSession) never reads what the query means.
    const signedQuery = "client_id=fixture-client&redirect_uri=https%3A%2F%2Fclaude.example%2Fcallback&sig=deadbeef&exp=9999999999";
    const response = await call(new Request(`${ORIGIN}${paths.oauthConsent}?${signedQuery}`));
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/login\?/);
    // `.searchParams.get` already decodes once — identity's loginRedirect encoded the
    // whole path+search exactly once, so this is the original bytes, not a second decode.
    const next = new URL(location, ORIGIN).searchParams.get("next") ?? "";
    expect(next).toBe(`${paths.oauthConsent}?${signedQuery}`);
  });

  it("§19.5 · the post-login redirect target is the hub's own /api/auth/oauth2/authorize — a next= or return_to= parameter added to the login query changes nothing about where the browser lands", async () => {
    const { clientId } = await registerOAuthClient();
    const authorized = await call(new Request(authorizeUrl(clientId)));
    expect(authorized.status).toBe(302);
    const location = authorized.headers.get("Location") ?? "";
    expect(location).toMatch(/^\/login\?/);
    // An attacker (or a careless client) tacking on next=/return_to=: neither is ever read.
    const tampered = `${location}&next=%2Fevil&return_to=%2Fevil2`;
    const html = await anonymousPage(tampered);
    const callbackUrl = /name="callbackURL"\s+value="([^"]*)"/.exec(html)?.[1];
    expect(callbackUrl, "no callbackURL field rendered").not.toBeUndefined();
    const decoded = decodeEntities(callbackUrl ?? "");
    expect(decoded.startsWith(`${paths.auth.base}/oauth2/authorize?`)).toBe(true);
    expect(decoded).toContain(`client_id=${clientId}`);
    expect(decoded).not.toContain("/evil");
  });

  it("§19.5 · the consent page renders the client's name, the requested scopes, the namespace, and an agent picker listing every agent in the namespace", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "Acme Connector" });
    const { html } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(html).toContain("Acme Connector");
    expect(html).toContain(">mcp<");
    expect(html).toContain(world.ns.owner.username);
    expect(html).toContain('value="agent"');
  });

  it("§19.5 · the consent page names the redirect_uri's ORIGIN — the string that decides where the code goes is shown to the owner, not just the client's self-chosen name", async () => {
    const { clientId } = await registerOAuthClient();
    const { html } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(html).toContain(new URL(OAUTH_REDIRECT_URI).origin);
  });

  it('§19.5 · a self-registered (DCR) client\'s name carries the "registered itself, identity unverified" marker · a pre-registered client does not (the twin)', async () => {
    const dcr = await registerOAuthClient({ client_name: "Anon Client" });
    const preRegistered = await registerOAuthClient({ client_name: "Known Client" }, world.session.cookie);
    const resource = oauthResourceFor(world.ns.owner.username);
    const dcrHtml = (await reachConsent(dcr.clientId, world.session.cookie, { resource })).html;
    const knownHtml = (await reachConsent(preRegistered.clientId, world.session.cookie, { resource })).html;
    expect(dcrHtml).toContain("registered itself");
    expect(knownHtml).not.toContain("registered itself");
  });

  it("§19.5 · a client name containing markup is rendered as text — the consent screen displays attacker-supplied strings and escapes every one", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "<script>alert(1)</script>" });
    const { html } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // G8 (2026-09-03): the empty state sent the owner to /apps, which cannot create an agent.
  // §19.5 amended; this row replaces the one below it, which is retired with the fix.
  it(`§19.5 · a namespace with zero agents renders the picker's empty state naming the Agents page — "Create one under Agents before connecting a client." linking /agents/new, never /apps, which has no agent affordance — and disables submit; consent is impossible until an agent exists · the same page with one agent submits (the twin)`, async () => {
    const empty = await seedNamespace(env.DB, {});
    const emptySession = await seedOwnerSession(empty.owner);
    const emptyClient = await registerOAuthClient();
    const emptyHtml = (
      await reachConsent(emptyClient.clientId, emptySession.cookie, { resource: oauthResourceFor(empty.owner.username) })
    ).html;
    expect(textOf(emptyHtml)).toMatch(/Create one under\s+Agents\s+before connecting a client/);
    expect(emptyHtml).toContain(`href="${paths.agentNew}"`);
    expect(emptyHtml).not.toContain(`href="${paths.apps}"`);
    expect(submitButtonHtml(emptyHtml, "accept")).toContain("disabled");

    // The twin: the fixture namespace has an agent, so the same button is submittable.
    const fullClient = await registerOAuthClient();
    const fullHtml = (
      await reachConsent(fullClient.clientId, world.session.cookie, { resource: oauthResourceFor(world.ns.owner.username) })
    ).html;
    expect(submitButtonHtml(fullHtml, "accept")).not.toContain("disabled");
  });

  it("§19.5 · the consent form echoes the signed oauth_query byte-for-byte in a hidden field", async () => {
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const field = /name="oauth_query"\s+value="([^"]*)"/.exec(html)?.[1];
    expect(field, "no oauth_query hidden field rendered").not.toBeUndefined();
    expect(decodeEntities(field ?? "")).toBe(oauthQuery);
  });

  it("§19.5 · POST /oauth/consent without a CSRF token is refused and writes no binding · the same POST with one binds and redirects (the twin)", async () => {
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const refused = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "agent" },
      {},
    );
    expect(refused.status).toBe(403);
    expect(await bindingFor(world.ns.owner.userId, clientId)).toBeNull();

    const csrf = csrfOf(html);
    const accepted = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "agent" },
      { csrf },
    );
    expect(accepted.status, await accepted.text()).toBe(303);
    expect(await bindingFor(world.ns.owner.userId, clientId)).not.toBeNull();
  });

  it("§19.5 · POST /oauth/consent with an edited oauth_query is refused by the signature check and writes no binding", async () => {
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const csrf = csrfOf(html);
    const edited = new URLSearchParams(oauthQuery);
    edited.set("client_id", `${clientId}-tampered`);
    const refused = await post(
      paths.oauthConsent,
      { oauth_query: edited.toString(), decision: "accept", agent: "agent" },
      { csrf },
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await bindingFor(world.ns.owner.userId, clientId)).toBeNull();
  });

  it("§19.5 · accepting writes one oauth_binding row bound to the chosen agent and an oauth.consented audit row", async () => {
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const csrf = csrfOf(html);
    const before = await query(env.DB, world.ns.owner.userId, { event: "oauth.consented" });
    const accepted = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "agent" },
      { csrf },
    );
    expect(accepted.status, await accepted.text()).toBe(303);
    const binding = await bindingFor(world.ns.owner.userId, clientId);
    expect(binding).not.toBeNull();
    expect(binding?.agentId).toBe(world.ns.agents.agent.id);
    const after = await query(env.DB, world.ns.owner.userId, { event: "oauth.consented" });
    expect(after.total).toBe(before.total + 1);
  });

  it("§19.5 · consenting again with a different agent UPDATEs the same row and writes oauth.rebound — never a second row", async () => {
    const ns = await seedNamespace(env.DB, { agents: [{ slug: "one" }, { slug: "two" }] });
    const session = await seedOwnerSession(ns.owner);
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, session.cookie, {
      resource: oauthResourceFor(ns.owner.username),
    });
    const csrf = csrfOf(html);
    const first = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "one" },
      { csrf, cookie: session.cookie },
    );
    expect(first.status, await first.text()).toBe(303);
    const afterFirst = await bindingFor(ns.owner.userId, clientId);
    expect(afterFirst?.agentId).toBe(ns.agents.one.id);

    // The SAME signed query, posted again with a different chosen agent — the provider's
    // own /oauth2/consent accepts a re-post of it (it only re-verifies the signature).
    const second = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "two" },
      { csrf, cookie: session.cookie },
    );
    expect(second.status, await second.text()).toBe(303);
    const afterSecond = await bindingFor(ns.owner.userId, clientId);
    expect(afterSecond?.agentId).toBe(ns.agents.two.id);
    expect(afterSecond?.id).toBe(afterFirst?.id);
    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);
    const rebound = await query(env.DB, ns.owner.userId, { event: "oauth.rebound" });
    expect(rebound.total).toBe(1);
  });

  it("§19.5 · denying writes no binding and redirects to the client with access_denied", async () => {
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const csrf = csrfOf(html);
    const denied = await post(paths.oauthConsent, { oauth_query: oauthQuery, decision: "deny" }, { csrf });
    expect(denied.status, await denied.text()).toBe(303);
    expect(denied.headers.get("Location")).toContain("error=access_denied");
    expect(await bindingFor(world.ns.owner.userId, clientId)).toBeNull();
  });

  it("§19.5 · a consent POST naming an agent in another namespace is refused", async () => {
    await seedNamespace(env.DB, { agents: [{ slug: "outsider" }] });
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const csrf = csrfOf(html);
    const refused = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "outsider" },
      { csrf },
    );
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).toBeLessThan(500);
    expect(await bindingFor(world.ns.owner.userId, clientId)).toBeNull();
  });

  // The `/oauth/connections` listing row that stood here is gone with the page it was
  // written against (D15): §13 re-homed the list as the Connected clients pane, and its
  // three halves are three rows of that pane's describe — the 301, the listing's own
  // identity strings, and the CSRF gate proven on BOTH ops-backed dispatchers.

  it("§19.6 · Revoke sets revoked_at, deletes the provider's consent row, and writes oauth.revoked", async () => {
    const { clientId } = await registerOAuthClient();
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const csrf = csrfOf(html);
    await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "agent" },
      { csrf },
    );
    const binding = await bindingFor(world.ns.owner.userId, clientId);
    expect(binding).not.toBeNull();
    expect(await consentRowExists(world.ns.owner.userId, clientId)).toBe(true);

    // Re-pointed with the pane (D15): the list lives at /settings/clients, and its Revoke
    // is behind a confirm dialog — which is where the token this posts comes from, because
    // the bare pane renders no form of its own.
    const listed = await page(paths.settingsClients);
    const dialog = await page(confirmLinkFor(listed, "revoke-connection", binding?.id ?? "") ?? "");
    const before = await query(env.DB, world.ns.owner.userId, { event: "oauth.revoked" });
    const revoked = await post(
      paths.connectionRevoke(binding?.id ?? ""),
      {},
      { csrf: csrfOf(dialog) },
    );
    expect(revoked.status, await revoked.text()).toBe(303);

    const after = await bindingFor(world.ns.owner.userId, clientId);
    expect(after?.revokedAt).not.toBeNull();
    expect(await consentRowExists(world.ns.owner.userId, clientId)).toBe(false);
    const revokedRows = await query(env.DB, world.ns.owner.userId, { event: "oauth.revoked" });
    expect(revokedRows.total).toBe(before.total + 1);
  });
});

/* ------------------------------------------------------------------ *
 * §19: driving the provider itself — DCR, authorize, the consent page
 * ------------------------------------------------------------------ */

const OAUTH2 = `${ORIGIN}/api/auth/oauth2`;

/** Any https, non-loopback redirect URI — the provider's "web" application-type policy
 *  accepts it, and exact-match redirect_uri enforcement is oauth-provider.test.ts's, not
 *  this file's business. */
const OAUTH_REDIRECT_URI = "https://claude.example/callback";

/** RFC 7636 Appendix B's S256 challenge — a real value, not a secret; PKCE is required of
 *  every client (§19.3) so every authorize call in this file carries one. */
const PKCE_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

/**
 * Registers a public client through anonymous DCR (§19.3). `cookie`, when given, makes this
 * a "pre-registered" client instead: the registration endpoint accepts an optional session
 * and writes its `userId` when one rides along — the DCR-marker twin (case 5) is built from
 * this one difference, read back by consentProps' `isDcrClient`.
 */
// D15 (2026-09-02) — every describe below comes from the row list in
// docs/superpowers/plans/2026-09-02-d15-panes.md; each row's mechanics are on its
// `asserts:` line there, which is where a reader goes to see what a title was meant to pin.

describe(`§13 · the /settings shell — seven panes behind one rail`, () => {
  it(`§13 · each of the seven settings panes answers at its own URL and /settings renders the Password pane · /settings/password is a 404, not an alias and not a redirect (the twin: the six other pane URLs all answer 200)`, async () => {
    for (const pane of PANES) {
      expect((await get(pane, world.session.cookie)).status, `GET ${pane}`).toBe(200);
    }
    // Scoped to the RAIL: layout.tsx renders an `aria-current="page"` anchor to /settings
    // in the shell header of every signed-in page, so a page-wide count reads two.
    const current = railEntries(await page(paths.settings), RAIL_NAV_LABEL).filter((e) => e.current);
    expect(current.map((e) => e.href), "the landing pane is not Password").toEqual([paths.settings]);
    // No alias for the landing pane: not a 301, not a 302, not a 303 — nothing to follow.
    const alias = await get(`${paths.settings}/password`);
    expect(alias.status, "GET /settings/password").toBe(404);
    expect(alias.headers.get("Location")).toBeNull();
  });

  it(`§13 · every pane renders the same rail — seven entries under Sign-in, Access and Runtime, in the sign-in-then-holdings order, each linking to its own pane URL — the Password entry carries no marker where the six others do, and the entry for the pane being rendered is the only rail entry carrying aria-current="page"`, async () => {
    for (const pane of PANES) {
      const html = await page(pane);
      const entries = railEntries(html, RAIL_NAV_LABEL);
      expect(entries.map((e) => e.href), `the rail on ${pane}`).toEqual(PANES);
      expect(entries[5].label).toBe("Connected clients");
      expect(entries.filter((e) => e.current).map((e) => e.href), `aria-current on ${pane}`).toEqual([pane]);
      // The groups, read positionally out of the rail's own markup rather than off a
      // class: §7 makes the heading's element and styling incidental, its ORDER durable.
      const block = navBlock(html, RAIL_NAV_LABEL) ?? "";
      const at = (needle: string): number => {
        const found = block.indexOf(needle);
        expect(found, `the rail on ${pane} carries no ${needle}`).toBeGreaterThanOrEqual(0);
        return found;
      };
      expect(at("Sign-in")).toBeLessThan(at(`href="${paths.settings}"`));
      expect(at("Access")).toBeGreaterThan(at(`href="${paths.settingsPasskeys}"`));
      expect(at("Access")).toBeLessThan(at(`href="${paths.settingsSessions}"`));
      // §13's Runtime group holds the one pane that configures what programs may SPEND:
      // after Access, and before the Execution entry it heads.
      expect(at("Runtime")).toBeGreaterThan(at(`href="${paths.settingsClients}"`));
      expect(at("Runtime")).toBeLessThan(at(`href="${paths.settingsExecution}"`));
      // §13's pane table: Password's marker cell reads `none`. The six beside it are what
      // keeps that absence a fact about Password rather than about the rail.
      expect(entries[0].marker, `the Password marker on ${pane}`).toBe("");
      for (const entry of entries.slice(1)) {
        expect(entry.marker, `the ${entry.label} marker on ${pane}`).not.toBe("");
      }
    }
  });

  it(`§13 · every rail count is the number of rows its own pane lists — passkeys, sessions, tokens and connected clients seeded to four different lengths, so no single number satisfies the rail`, async () => {
    // Four different lengths on purpose: 2 passkeys, 3 sessions, 4 tokens, 1 client. A
    // rail that answered one number for every entry cannot pass this.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app1" }, { as: "app2" }] }],
      agents: [{ slug: "agent", tokens: [{ as: "agt1" }, { as: "agt2" }] }],
    });
    const first = await seedOwnerSession(ns.owner);
    const second = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const planted = [
      await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" }),
      await plantPasskey(ns.owner.userId, { name: "YubiKey 5C" }),
    ];
    const { clientId } = await consentOnce(ns, viewer.cookie, "agent", { client_name: "Counted Client" });

    // Each marker is read off the pane it belongs to, and compared with the identifiers
    // that pane actually drew — distinct ids, never link occurrences (the sessions card
    // renders twice into one document).
    const passkeys = await page(paths.settingsPasskeys, viewer.cookie);
    expect(markerOf(passkeys, paths.settingsPasskeys)).toBe("2");
    for (const id of planted) {
      expect(passkeys).toContain(
        paths.settingsConfirm("passkeys", "remove-passkey", id).replace(/&/g, "&amp;"),
      );
    }

    const sessions = await page(paths.settingsSessions, viewer.cookie);
    expect(markerOf(sessions, paths.settingsSessions)).toBe("3");
    // Two revocable rows plus the current one, which never carries a link (§13) — all
    // three named, so the marker's "3" is `2 + 1` counted rather than assumed.
    expect(revocableIds(sessions)).toEqual(
      new Set([await sessionIdOf(first.cookie), await sessionIdOf(second.cookie)]),
    );
    expect(revocableIds(sessions).has(await sessionIdOf(viewer.cookie))).toBe(false);

    const tokensPane = await page(paths.settingsTokens, viewer.cookie);
    expect(markerOf(tokensPane, paths.settingsTokens)).toBe("4");
    const listed = (await ops.token_list.handler(ns.owner.userId, {})) as {
      tokens: { prefix: string }[];
    };
    expect(listed.tokens.length).toBe(4);
    for (const token of listed.tokens) expect(tokensPane).toContain(token.prefix);

    const clients = await page(paths.settingsClients, viewer.cookie);
    expect(markerOf(clients, paths.settingsClients)).toBe("1");
    expect(clients).toContain("Counted Client");
    expect(await bindingFor(ns.owner.userId, clientId)).not.toBeNull();
  });

  it(`§13 · the Two-factor rail marker is a status, not a count: it reads one way with TOTP enabled and another without it, and never a number · the Passkeys entry beside it is a number in both states (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // ONE planted passkey, so the twin's count is a real "1" rather than the empty string
    // — Number("") is 0, and a marker that vanished would otherwise read as a number.
    await plantPasskey(ns.owner.userId, { name: "YubiKey 5C" });

    const before = await page(paths.settingsTwoFactor, session.cookie);
    const notEnrolled = markerOf(before, paths.settingsTwoFactor);
    expect(notEnrolled).not.toBe("");
    expect(Number.isNaN(Number(notEnrolled)), `"${notEnrolled}" reads as a number`).toBe(true);
    expect(Number(markerOf(before, paths.settingsPasskeys))).toBe(1);

    await enrollTwoFactor(ns.owner.userId);
    const after = await page(paths.settingsTwoFactor, session.cookie);
    const enrolled = markerOf(after, paths.settingsTwoFactor);
    expect(enrolled).not.toBe("");
    expect(Number.isNaN(Number(enrolled)), `"${enrolled}" reads as a number`).toBe(true);
    expect(enrolled, "the marker says the same thing in both states").not.toBe(notEnrolled);
    expect(Number(markerOf(after, paths.settingsPasskeys))).toBe(1);
  });
  it(`§4/§13 · the /settings gate is a prefix rule: a stale cookie and a bearer-sourced session are refused on all seven panes, the three ops-backed ones included · the same seven panes render on a session signed in moments ago (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, { apps: [{ slug: "news", kind: "tunnel" }] });
    // Two sign-ins for ONE owner: ageing one cannot age the twin it is compared against.
    const stale = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    const fresh = await seedOwnerSession(ns.owner);
    // A real device-flow bearer replayed as a cookie value. better-auth's session cookie
    // is signed, so this resolves to nobody — which is what "bearer-sourced sessions are
    // rejected" IS, structurally.
    const deviceCookie = `${fresh.cookie.split("=")[0]}=${await deviceFlowToken(fresh.cookie)}`;

    let walked = 0;
    for (const pane of PANES) {
      const aged = await get(pane, stale.cookie);
      expect(aged.status, `GET ${pane} on a day-old cookie`).toBe(302);
      expect(aged.headers.get("Location"), `GET ${pane}`).toMatch(/^\/login(\?|$)/);
      const bearerSourced = await get(pane, deviceCookie);
      expect(bearerSourced.status, `GET ${pane} on a device-flow token`).toBe(302);
      expect(bearerSourced.headers.get("Location"), `GET ${pane}`).toMatch(/^\/login(\?|$)/);
      expect((await get(pane, fresh.cookie)).status, `GET ${pane} on a fresh cookie`).toBe(200);
      walked += 1;
    }
    expect(walked, "the walk did not cover seven panes").toBe(7);
  });

  it(`§4/§13 · every POST target under /settings/ refuses a day-old cookie carrying its own real CSRF token and never reaches its op — the credential targets and the three ops-backed panes' alike · the same posts from a fresh session are accepted (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent", tokens: [{ as: "agt" }] }],
    });
    const stale = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    const fresh = await seedOwnerSession(ns.owner);
    const passkeyId = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    await consentOnce(ns, fresh.cookie, "agent");
    await enrollTwoFactor(ns.owner.userId);

    // Harvested FIRST, while the ops table is still real: the substitution below replaces
    // the read handlers too, so no pane can be rendered under it.
    const rendered = await settingsPostTargets(fresh.cookie);
    // The credential family is derived from `paths.auth`, so a sixth one added there is
    // walked without editing this row; the rendered targets are everything else.
    for (const target of SETTINGS_CREDENTIAL_TARGETS) {
      if (!rendered.has(target)) rendered.set(target, { pane: paths.settings, fields: {} });
    }
    const targets = [...rendered].map(([action, found]) => ({ action, ...found }));
    const finalSegment = (action: string): string =>
      action.split("?")[0].split("/").filter(Boolean).pop() ?? "";
    expect(targets.map((t) => finalSegment(t.action))).toContain("token_revoke");
    expect(targets.map((t) => finalSegment(t.action))).toContain("connection_revoke");
    // Each session's OWN token, off a page it can still render (/apps carries no recency
    // gate), so the refusals below cannot be the CSRF check answering — and harvested out
    // here, because no page renders at all once the read handlers are substituted.
    const staleCsrf = bootstrapCsrfOf(await page(paths.apps, stale.cookie));
    const freshCsrf = bootstrapCsrfOf(await page(paths.apps, fresh.cookie));
    const bearerCookie = `${fresh.cookie.split("=")[0]}=${await deviceFlowToken(fresh.cookie)}`;
    // Session-ending targets last: `revoke-other-sessions` succeeds and would kill the
    // aged twin the refusal legs ride.
    const walk = targets.sort((a, b) => Number(ENDS_SESSIONS(a.action)) - Number(ENDS_SESSIONS(b.action)));
    // The world the refusal legs are judged against, snapshotted while it is whole. One
    // render carries every marker, and both are READ rather than spelled: the device flow
    // above minted a session of its own, and §13's Two-factor marker is a status word.
    const railBefore = await page(paths.settingsSessions, fresh.cookie);

    // The refusal legs FIRST and together, so nothing the twin legs below change can be
    // mistaken for the gate having let one through.
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const { action, fields } of walk) {
        const op = finalSegment(action);
        const aged = await formPost(action, { ...fields, csrf: staleCsrf, password: WRONG_PASSWORD }, stale.cookie);
        expect(aged.status, `POST ${action} on a day-old cookie`).toBe(302);
        expect(aged.headers.get("Location"), `POST ${action}`).toMatch(/^\/login(\?|$)/);

        const replayed = await formPost(action, { ...fields, csrf: staleCsrf, password: WRONG_PASSWORD }, bearerCookie);
        expect(replayed.status, `POST ${action} on a device-flow token`).toBe(302);
        expect(replayed.headers.get("Location"), `POST ${action}`).toMatch(/^\/login(\?|$)/);

        // Only where there IS an op to count: `times` is keyed by ops names, so for the
        // seven credential targets — which front no op — this leg says nothing at all.
        // What stands in for them is the untouched world asserted below.
        if (Object.prototype.hasOwnProperty.call(ops, op)) {
          expect(times(invocations, op), `POST ${action} reached ${op}`).toBe(0);
        }
      }
    });

    // "Never reached its op", said about the six credential targets that HAVE no op:
    // `times` counts ops names, so the leg above is 0 === 0 for them by construction and
    // this is what stands in its place — the passkey they would have deleted still
    // listed, no session revoked, the second factor still enrolled. Outside the
    // substitution, because a pane cannot render while its own reads are counting stubs.
    // (The seventh, Update password, is measured by `signsIn` in the Password pane's own
    // stale-cookie row: this owner is enrolled in 2FA, so a sign-in here never returns a
    // cookie and the probe would say nothing.)
    expect(
      confirmLinkFor(await page(paths.settingsPasskeys, fresh.cookie), "remove-passkey", passkeyId),
      "the refused delete-passkey removed the passkey anyway",
    ).not.toBeNull();
    const railAfter = await page(paths.settingsSessions, fresh.cookie);
    expect(
      markerOf(railAfter, paths.settingsSessions),
      "the refused revokes ended a session anyway",
    ).toBe(markerOf(railBefore, paths.settingsSessions));
    expect(
      markerOf(railAfter, paths.settingsTwoFactor),
      "the refused two-factor posts moved the second factor anyway",
    ).toBe(markerOf(railBefore, paths.settingsTwoFactor));

    // THE TWIN: the same submissions from a session signed in moments ago, answered by
    // the target rather than by the gate — a notice on a pane, never a login bounce.
    // §4 splits the credential family by whether the target takes a password: the four
    // that do must refuse `WRONG_PASSWORD`, and the three that take none (remove passkey,
    // revoke session, revoke all others) legitimately succeed.
    const PASSWORD_GUARDED: readonly string[] = [
      paths.auth.totpEnable,
      paths.auth.totpDisable,
      paths.auth.backupCodesGenerate,
      paths.auth.changePassword,
    ];
    const UNGUARDED: readonly string[] = [
      paths.auth.passkeyDelete,
      paths.auth.sessionRevoke,
      paths.auth.revokeOtherSessions,
    ];
    // Two tokens mean two `token_revoke` targets, so "the op ran once" is counted per
    // POST rather than per op name.
    const expected = new Map<string, number>();
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const { action, fields } of walk) {
        const op = finalSegment(action);
        const before = expected.get(op) ?? 0;
        const answered = await formPost(action, { ...fields, csrf: freshCsrf, password: WRONG_PASSWORD }, fresh.cookie);
        expect(answered.status, `POST ${action} on a fresh cookie`).toBe(303);
        const location = answered.headers.get("Location") ?? "";
        expect(location, `POST ${action}`).not.toMatch(/^\/login(\?|$)/);
        if (Object.prototype.hasOwnProperty.call(ops, op)) {
          expect(times(invocations, op), `POST ${action} reached ${op}`).toBe(before + 1);
          expect(location, `POST ${action}`).toContain("done=");
          expected.set(op, before + 1);
        } else if (PASSWORD_GUARDED.includes(action)) {
          expect(location, `POST ${action} accepted a password that is not the owner's`).toContain("failed=");
        } else if (UNGUARDED.includes(action)) {
          expect(location, `POST ${action}`).toContain("done=");
        } else {
          // A credential target added to `paths.auth` after this row was written: the walk
          // still covers it, and only its regime is unknown until someone says which it is.
          expect(location, `POST ${action}`).toMatch(/[?&](done|failed)=/);
        }
      }
    });
    // The Add-passkey ceremony is the one /settings credential POST this walk cannot see:
    // it is not a form. The Passkeys pane's ceremony row is what claims it.
  });

  it(`§13 · a mutation posted from a pane redirects back to that pane's own URL carrying its notice, and the pane at that Location renders it — done= from the ops-backed targets, failed= from a refused credential — never to the page root unless the root is the pane that rendered the form`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent", tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    // A SECOND session, because the Sessions pane draws a Revoke link only beside a row
    // that is not the current one: with one session the pane renders no
    // `?confirm=revoke-session` link and the harvest below quietly walks one target short.
    await seedOwnerSession(ns.owner);
    await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    await consentOnce(ns, session.cookie, "agent");
    await enrollTwoFactor(ns.owner.userId);

    const targets = await settingsPostTargets(session.cookie);
    // The three targets whose owning pane is NOT the root, and which exist only behind a
    // `?confirm=` dialog — an under-seeded world fails HERE rather than passing on a
    // shorter walk.
    expect([...targets.keys()]).toEqual(
      expect.arrayContaining([paths.auth.sessionRevoke, paths.auth.passkeyDelete, paths.auth.totpDisable]),
    );
    const panes = new Set([...targets.values()].map((found) => found.pane));
    expect(panes.has(paths.settings), "no harvested form is drawn on the page root").toBe(true);
    expect([...panes].some((pane) => pane !== paths.settings), "every harvested form is on the root").toBe(true);

    const walk = [...targets].sort(([a], [b]) => Number(ENDS_SESSIONS(a)) - Number(ENDS_SESSIONS(b)));
    const landings: { pane: string; location: string; flash: string; done: boolean }[] = [];
    // Two tokens mean two `token_revoke` targets, so the count is kept per POST.
    const expected = new Map<string, number>();
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const [action, { pane, fields }] of walk) {
        const op = action.split("?")[0].split("/").filter(Boolean).pop() ?? "";
        const answered = await formPost(action, { ...fields, password: WRONG_PASSWORD }, session.cookie);
        expect(answered.status, `POST ${action}`).toBe(303);
        const location = answered.headers.get("Location") ?? "";
        expect(new URL(location, ORIGIN).pathname, `POST ${action} landed off its pane`).toBe(pane);
        const outcome = new URL(location, ORIGIN).searchParams;
        const flash = outcome.get("done") ?? outcome.get("failed") ?? "";
        expect(flash, `POST ${action} carried no notice`).not.toBe("");
        landings.push({ pane, location, flash, done: outcome.get("done") !== null });
        if (Object.prototype.hasOwnProperty.call(ops, op)) {
          const ran = (expected.get(op) ?? 0) + 1;
          expect(times(invocations, op), `POST ${action} reached ${op}`).toBe(ran);
          expected.set(op, ran);
        }
      }
    });
    // FOLLOWED outside the substitution — a pane cannot render while its own reads are
    // counting handlers — because a pane that dropped `notice` from its props would
    // otherwise pass on the Location alone.
    // Both arms are walked, so neither branch below is satisfied by an empty set.
    expect(landings.some((row) => row.done), "no target answered done=").toBe(true);
    expect(landings.some((row) => !row.done), "no target answered failed=").toBe(true);
    for (const { pane, location, flash, done } of landings) {
      const landed = await page(location, session.cookie);
      // The WHOLE sentence `noticeOf` builds, not the op name both arms share: a success
      // line reads "<Op> done." and a refusal "<Op> failed", so a pane that drew every
      // notice in one tone would otherwise pass on the prefix.
      const humanized = `${flash.charAt(0).toUpperCase()}${flash.slice(1).replace(/_/g, " ")}`;
      expect(landed, `${pane} rendered no notice for ${flash}`).toContain(
        done ? `${humanized} done.` : `${humanized} failed`,
      );
    }
  });

  it(`§13 · a confirm dialog rides the URL of the pane that owns it: every ?confirm= link a pane renders resolves to that same pane's path and draws its dialog there · the identical query on another pane's URL draws none (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, { agents: [{ slug: "agent" }] });
    const session = await seedOwnerSession(ns.owner);
    await seedOwnerSession(ns.owner);
    await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    await plantPasskey(ns.owner.userId, { name: "YubiKey 5C" });
    await consentOnce(ns, session.cookie, "agent");
    await enrollTwoFactor(ns.owner.userId);

    const harvested: { pane: string; href: string }[] = [];
    for (const pane of PANES) {
      for (const href of confirmLinksOn(await page(pane, session.cookie))) harvested.push({ pane, href });
    }
    expect(harvested.length, "no pane rendered a confirm link").toBeGreaterThan(0);

    for (const { pane, href } of harvested) {
      expect(new URL(href, ORIGIN).pathname, `${href} does not ride ${pane}`).toBe(pane);
      const withQuery = await page(href, session.cookie);
      const plain = await page(pane, session.cookie);
      const opened = formsOn(withQuery).filter((form) => !formsOn(plain).includes(form));
      expect(opened.length, `${href} drew no form the bare pane does not`).toBeGreaterThan(0);
    }

    // The twin: the same query on a pane that does not own it draws nothing.
    const foreign = harvested.find((row) => row.href.includes("id="));
    expect(foreign, "no id-carrying confirm link to move").toBeDefined();
    const query = new URL(foreign?.href ?? "", ORIGIN).search;
    const elsewhere = PANES.find((pane) => pane !== foreign?.pane) ?? paths.settings;
    expect(formsOn(await page(`${elsewhere}${query}`, session.cookie))).toEqual(
      formsOn(await page(elsewhere, session.cookie)),
    );
    // And a guessed id on the OWNING pane is no dialog either.
    const guessed = `${foreign?.pane ?? ""}?confirm=${new URL(foreign?.href ?? "", ORIGIN).searchParams.get("confirm") ?? ""}&id=${uniqueSlug("nope")}`;
    expect(formsOn(await page(guessed, session.cookie))).toEqual(
      formsOn(await page(foreign?.pane ?? paths.settings, session.cookie)),
    );
  });

  it(`§13 · the seven pane routes are the seven strings §13 spells — /settings, /settings/two-factor, /settings/passkeys, /settings/sessions, /settings/tokens, /settings/clients, /settings/execution — asserted against the literals once, since every other row reads them through paths`, () => {
    // Every other row here derives both sides from `paths`, so renaming a member would
    // leave the whole suite green. §7 puts routes on the durable side; this is where they
    // are spelled, once.
    expect([
      paths.settings,
      paths.settingsTwoFactor,
      paths.settingsPasskeys,
      paths.settingsSessions,
      paths.settingsTokens,
      paths.settingsClients,
      paths.settingsExecution,
    ]).toEqual([
      "/settings",
      "/settings/two-factor",
      "/settings/passkeys",
      "/settings/sessions",
      "/settings/tokens",
      "/settings/clients",
      "/settings/execution",
    ]);
  });

  it(`§13 · no rendered page links /oauth/consent — it is chromeless and has no nav slot, by design · the same pages link all seven settings panes (the twin)`, async () => {
    const linked = new Set<string>();
    for (const path of [...PANES, paths.apps]) {
      const html = await page(path);
      for (const anchor of html.matchAll(/<a\b[^>]*href="([^"]*)"/g)) {
        const href = decodeEntities(anchor[1]);
        if (!href.startsWith("/")) continue;
        const target = new URL(href, ORIGIN).pathname;
        expect(target, `${path} links the consent screen`).not.toBe(paths.oauthConsent);
        linked.add(target);
      }
    }
    // Non-vacuous by the same walk: these pages demonstrably do link pane URLs, so the
    // absence above is about /oauth/consent and not about a walk that found no anchors.
    expect([...PANES].filter((pane) => linked.has(pane))).toEqual([...PANES]);
  });

  it(`§13 · the mobile pill row lists the same seven pane URLs in the same order as the rail, markerless, and shortens only the Connected clients label, to Clients — structure only, nothing visual`, async () => {
    for (const pane of PANES) {
      const html = await page(pane);
      const rail = railEntries(html, RAIL_NAV_LABEL);
      const pills = railEntries(html, PILL_NAV_LABEL);
      expect(pills.map((e) => e.href), `the pill row on ${pane}`).toEqual(rail.map((e) => e.href));
      expect(pills.map((e) => e.href), `the pill row on ${pane}`).toEqual(PANES);
      // §13: "label only, no markers".
      expect(pills.map((e) => e.marker), `the pill row on ${pane}`).toEqual(PANES.map(() => ""));
      for (let at = 0; at < PANES.length; at += 1) {
        if (at === 5) continue;
        expect(pills[at].label, `pill ${at} on ${pane}`).toBe(rail[at].label);
      }
      // The single shortening, asserted as a DIFFERENCE so it cannot pass by accident.
      expect(rail[5].label).toBe("Connected clients");
      expect(pills[5].label).toBe("Clients");
      // §13 (pinned 2026-09-03): the active pill carries aria-current="page" like the
      // rail's active entry — exactly one pill per page, and it is this page's.
      const block = /<nav class="pill-row"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
      const current = [...block.matchAll(/<a class="pill" href="([^"]*)" aria-current="page">/g)].map((m) => m[1]);
      expect(current, `the current pill on ${pane}`).toEqual([pane]);
    }
  });

  it(`§4/§13 · an Authorization header with no cookie is bounced to /login at a /settings POST — a credential target and an ops-backed one alike — and reaches neither better-auth nor the op · the identical submissions under the owner's cookie are accepted (the twin)`, async () => {
    // Here rather than in auth-matrix, which can neither render a pane nor obtain the CSRF
    // token a page rendered — and without that token a refusal proves nothing about which
    // gate answered.
    const ns = await seedNamespace(env.DB, { agents: [{ slug: "agent", tokens: [{ as: "agt" }] }] });
    const session = await seedOwnerSession(ns.owner);
    const bearer = await deviceFlowToken(session.cookie);
    const tokensPane = await page(paths.settingsTokens, session.cookie);
    const seeded = (await ops.token_list.handler(ns.owner.userId, {})) as {
      tokens: { id: string; revokedAt: number | null }[];
    };
    const tokenId = seeded.tokens[0].id;
    const passwordForm = formsPostingTo(await page(paths.settings, session.cookie), paths.auth.changePassword)[0];
    expect(passwordForm, "the Password pane rendered no change-password form").toBeDefined();
    const revokeForm = formsPostingTo(tokensPane, paths.tokenRevoke(tokenId))[0];
    expect(revokeForm, "the Tokens pane rendered no revoke form for the seeded key").toBeDefined();

    const legs = [
      {
        action: paths.auth.changePassword,
        // Deliberately wrong, so the twin below cannot move the world it is measured in.
        fields: typedInto(passwordForm, {
          currentPassword: WRONG_PASSWORD,
          newPassword: WRONG_PASSWORD,
          confirmPassword: WRONG_PASSWORD,
        }),
        op: "",
      },
      { action: paths.tokenRevoke(tokenId), fields: revokeForm, op: "token_revoke" },
    ];

    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const leg of legs) {
        // The header ALONE — no Cookie — carrying the page's real CSRF token, so the only
        // rule that can answer is the gate's. `mutation` resolves the session BEFORE
        // checkCsrf, which is why the 403 is not what comes back.
        const refused = await call(
          new Request(`${ORIGIN}${leg.action}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-www-form-urlencoded",
              Origin: ORIGIN,
              Authorization: `Bearer ${bearer}`,
            },
            body: new URLSearchParams(leg.fields).toString(),
          }),
        );
        expect(refused.status, `POST ${leg.action} with a bearer and no cookie`).toBe(302);
        expect(refused.headers.get("Location"), `POST ${leg.action}`).toMatch(/^\/login(\?|$)/);
        expect(sessionCookieOf(refused)).toBeNull();
        if (leg.op !== "") expect(times(invocations, leg.op), `POST ${leg.action}`).toBe(0);
      }
    });

    // Nothing moved — read with the real ops table back, which is also why the counting
    // block above holds only the refusals.
    const untouched = (await ops.token_list.handler(ns.owner.userId, {})) as {
      tokens: { id: string; revokedAt: number | null }[];
    };
    expect(untouched.tokens.find((row) => row.id === tokenId)?.revokedAt ?? null).toBeNull();
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    // The twin: the identical submissions under the owner's own cookie and no header.
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const leg of legs) {
        const answered = await formPost(leg.action, leg.fields, session.cookie);
        expect(answered.status, `POST ${leg.action} under the owner's cookie`).toBe(303);
        const location = answered.headers.get("Location") ?? "";
        if (leg.op === "") {
          expect(location, `POST ${leg.action}`).toContain("failed=");
        } else {
          expect(location, `POST ${leg.action}`).toContain("done=");
          expect(times(invocations, leg.op), `POST ${leg.action}`).toBe(1);
        }
      }
    });
  });

  it(`§13 · nothing is added TO the consent screen either: /oauth/consent renders neither paned page's rail and neither pill row — chromeless, no nav slot · the same helpers find the seven entries on a settings pane (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, { agents: [{ slug: "agent" }] });
    const session = await seedOwnerSession(ns.owner);
    const { clientId } = await registerOAuthClient();
    const { html } = await reachConsent(clientId, session.cookie, {
      resource: oauthResourceFor(ns.owner.username),
    });
    for (const label of [RAIL_NAV_LABEL, PILL_NAV_LABEL, APP_RAIL_NAV_LABEL, APP_PILL_NAV_LABEL]) {
      expect(railEntries(html, label), `/oauth/consent rendered "${label}"`).toEqual([]);
    }
    // The twin, so the four empties are the page's answer and not the helper's: the same
    // helper finds seven entries on a settings pane in this same case.
    expect(railEntries(await page(paths.settings, session.cookie), RAIL_NAV_LABEL).length).toBe(7);
  });
});

describe(`§4/§13 · the Password pane`, () => {
  it(`§13 · /settings lands on the Password pane: current password, new password, confirm new password, Sign out my other sessions checked by default, Update password — and the footer that sends a forgotten password to the server script, verbatim`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const { pane, form } = await passwordForm(session.cookie);

    expect(actionFor(pane, "change-password")).toBe(paths.auth.changePassword);
    // Typing into the three controls IS the assertion that the page drew all three:
    // `typedInto` refuses a name the rendered form never carried.
    typedInto(form, { currentPassword: "", newPassword: "", confirmPassword: "" });
    expect(form.csrf ?? "").not.toBe("");
    // THE DEFAULT, said as a submission: an unticked box contributes nothing to a
    // browser's body, so the untouched submission carrying the key is "checked".
    expect(Object.keys(form)).toContain("revokeOtherSessions");
    expect(pane).toContain("Update password");

    // §13's footer in three fragments, so the spec's `<username>` placeholder and the
    // page's substituted username both pass; what sits between them is not asserted.
    const text = textOf(pane);
    expect(text).toContain(
      "No email is on file, so there is no reset link: a forgotten password is recovered on the server with ",
    );
    expect(text).toContain("pnpm users reset-password");
    expect(text).toContain(" (§12). Changing it here needs the current one.");
    // §13's other half of the flag's cost — every CLI session is among the "others".
    expect(text).toContain("pmcp login");

    // Parity as a POSITIVE: every form this pane draws is a credential translation, and
    // change-password is one of them (§8's pinned exception, stated rather than assumed).
    // `formsRenderedOn` and not `formsOn`: a submit button's `formaction` is a target of
    // its own, and one this leg would otherwise never walk.
    const drawn = formsRenderedOn(pane).map((form) => form.op);
    expect(drawn.length).toBeGreaterThan(0);
    for (const op of drawn) expect(BETTER_AUTH_ACTIONS.has(op), `${op} is no credential`).toBe(true);
    expect(drawn).toContain("change-password");
  });

  it(`§13/§4 · the length hint renders from the one configured minimum: a new password one character short is refused with the pane carrying no second number, sets no cookie and leaves the password already on file signing in · one of exactly PASSWORD_MIN_LENGTH characters is accepted (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const { pane, form } = await passwordForm(session.cookie);

    // ONE number on the page, and it is the constant better-auth is configured from.
    const hints = [...pane.matchAll(/At least (\d+) characters\./g)];
    expect(hints.length, "the pane renders no length hint").toBeGreaterThan(0);
    for (const hint of hints) expect(hint[1]).toBe(String(PASSWORD_MIN_LENGTH));

    const short = fakePassword(PASSWORD_MIN_LENGTH - 1);
    const refused = await formPost(
      actionFor(pane, "change-password"),
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: short,
        confirmPassword: short,
      }),
      session.cookie,
    );
    expect(refused.status).toBe(303);
    const back = refused.headers.get("Location") ?? "";
    expect(back).toContain(paths.settings);
    expect(back).toContain("failed=");
    expect(sessionCookieOf(refused)).toBeNull();
    // The refusal is the LENGTH one and neither of the other two. The hint's own presence
    // afterwards is not asserted: it is drawn on every render either way.
    const drawn = await page(back, session.cookie);
    expect(drawn).not.toContain("That password is not right.");
    expect(drawn).not.toContain("The two entries do not match.");
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, short)).toBe(false);

    // THE TWIN, one character longer — an off-by-one or a second literal fails one leg.
    const exact = fakePassword(PASSWORD_MIN_LENGTH);
    const again = await passwordForm(session.cookie);
    const accepted = await formPost(
      actionFor(again.pane, "change-password"),
      unticked(
        typedInto(again.form, {
          currentPassword: SEEDED_OWNER_PASSWORD,
          newPassword: exact,
          confirmPassword: exact,
        }),
      ),
      session.cookie,
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("Location") ?? "").toContain("done=");
    expect(await signsIn(ns.owner.username, exact)).toBe(true);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(false);
  });

  it(`§13 · a wrong current password is refused with "That password is not right.", changes nothing and touches no session — the password already on file still signs in and a bystander session still opens a page · the right one changes it (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const actor = await seedOwnerSession(ns.owner);
    const bystander = await seedOwnerSession(ns.owner);
    const before = await sessionIdOf(actor.cookie);
    const { pane, form } = await passwordForm(actor.cookie);
    const wanted = fakePassword(20);

    const refused = await formPost(
      actionFor(pane, "change-password"),
      typedInto(form, {
        currentPassword: WRONG_PASSWORD,
        newPassword: wanted,
        confirmPassword: wanted,
      }),
      actor.cookie,
    );
    expect(refused.status).toBe(303);
    const back = refused.headers.get("Location") ?? "";
    expect(back).toContain(paths.settings);
    expect(back).toContain("failed=");
    expect(sessionCookieOf(refused)).toBeNull();
    // "No session is touched", said of a session OTHER than the one posting as well.
    expect(await sessionIdOf(actor.cookie)).toBe(before);
    expect((await get(paths.apps, bystander.cookie)).status).toBe(200);

    const drawn = await page(back, actor.cookie);
    expect(drawn).toContain("That password is not right.");
    // Exclusivity, with the length hint deliberately outside it: it always renders.
    expect(drawn).not.toContain("The two entries do not match.");
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, wanted)).toBe(false);

    // THE TWIN, one field different — §13's "change is not reset" as the pair it is.
    const again = await passwordForm(actor.cookie);
    const accepted = await formPost(
      actionFor(again.pane, "change-password"),
      unticked(
        typedInto(again.form, {
          currentPassword: SEEDED_OWNER_PASSWORD,
          newPassword: wanted,
          confirmPassword: wanted,
        }),
      ),
      actor.cookie,
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("Location") ?? "").toContain("done=");
    expect(await signsIn(ns.owner.username, wanted)).toBe(true);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(false);
  });
  it(`§13 · new ≠ confirm is the one check the hub makes itself, made before better-auth is called: "The two entries do not match." comes back although the current password was right, the session id is unchanged and the password already on file still signs in · the same form with the two entries equal changes it (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const before = await sessionIdOf(session.cookie);
    const { pane, form } = await passwordForm(session.cookie);
    // Both well inside 12..128, so length cannot refuse, and the current password is
    // RIGHT — so better-auth, whose body schema carries no confirm field, would have
    // succeeded had the hub forwarded. That is the leg a forwarding hub goes red on.
    const typed = fakePassword(20);
    const mistyped = fakePassword(21);

    const refused = await formPost(
      actionFor(pane, "change-password"),
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: typed,
        confirmPassword: mistyped,
      }),
      session.cookie,
    );
    expect(refused.status).toBe(303);
    const back = refused.headers.get("Location") ?? "";
    expect(back).toContain("failed=");
    expect(sessionCookieOf(refused)).toBeNull();
    expect(await sessionIdOf(session.cookie)).toBe(before);

    const drawn = await page(back, session.cookie);
    expect(drawn).toContain("The two entries do not match.");
    expect(drawn).not.toContain("That password is not right.");
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, typed)).toBe(false);
    expect(await signsIn(ns.owner.username, mistyped)).toBe(false);

    // THE TWIN: the same form with the two entries equal.
    const again = await passwordForm(session.cookie);
    const accepted = await formPost(
      actionFor(again.pane, "change-password"),
      unticked(
        typedInto(again.form, {
          currentPassword: SEEDED_OWNER_PASSWORD,
          newPassword: typed,
          confirmPassword: typed,
        }),
      ),
      session.cookie,
    );
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("Location") ?? "").toContain("done=");
    expect(await signsIn(ns.owner.username, typed)).toBe(true);
  });

  it(`§13 · a refusal better-auth answers with a code the pane maps to no field changes nothing and renders neither mapped refusal sentence · a mapped code does render its own (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // Past better-auth's own ceiling — a length the hub knows nothing about, so reaching
    // a refusal at all is evidence better-auth's own validation ran. Spelled as a length.
    const enormous = fakePassword(200);
    const { pane, form } = await passwordForm(session.cookie);

    const unmapped = await formPost(
      actionFor(pane, "change-password"),
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: enormous,
        confirmPassword: enormous,
      }),
      session.cookie,
    );
    expect(unmapped.status).toBe(303);
    const back = unmapped.headers.get("Location") ?? "";
    expect(back).toContain(paths.settings);
    expect(back).toContain("failed=");
    expect(sessionCookieOf(unmapped)).toBeNull();
    // Nothing is asserted about the notice's own words: §13 quotes none for this arm.
    const drawn = await page(back, session.cookie);
    expect(drawn).not.toContain("That password is not right.");
    expect(drawn).not.toContain("The two entries do not match.");
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    // THE TWIN: a MAPPED code also answers `failed=`, and is distinguishable — which is
    // the whole of §13's "Anything else is the ordinary refusal notice".
    const again = await passwordForm(session.cookie);
    const legal = fakePassword(20);
    const mapped = await formPost(
      actionFor(again.pane, "change-password"),
      typedInto(again.form, {
        currentPassword: WRONG_PASSWORD,
        newPassword: legal,
        confirmPassword: legal,
      }),
      session.cookie,
    );
    expect(mapped.status).toBe(303);
    const mappedBack = mapped.headers.get("Location") ?? "";
    expect(mappedBack).toContain("failed=");
    expect(await page(mappedBack, session.cookie)).toContain("That password is not right.");
  });

  it(`§13 · the pane reports the gate's own clock: a session created a known number of minutes ago renders "Confirmed your identity N minutes ago." with that number, and a session of a different age renders a different one`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const a = await seedOwnerSession(ns.owner);
    const b = await seedOwnerSession(ns.owner);
    // EXACT minute multiples, so the row need not choose between floor and round; both
    // well inside `freshAge`, so `page`'s own 200 is the check that these ages are the
    // gate's `createdAt` and not an expiry.
    await ageSession(a.token, 7 * 60_000);
    await ageSession(b.token, 20 * 60_000);

    const under = await page(paths.settings, a.cookie);
    expect(under).toContain("Confirmed your identity 7 minutes ago.");
    expect(under).not.toContain("20 minutes");

    const other = await page(paths.settings, b.cookie);
    expect(other).toContain("Confirmed your identity 20 minutes ago.");
    expect(other).not.toContain("7 minutes");
  });
  it(`§13 · Update password with Sign out my other sessions left ticked walks end to end: "Password updated.", "2 other session(s) were signed out — this one stays.", better-auth's Set-Cookie carries a session id that is not the one that posted, the old cookie and the other browser session are sent to /login, the CLI's bearer is dead, and the Sessions pane afterwards offers no per-session Revoke and counts one`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const { actor, bystander, device, before, otherId } = await threeSessions(ns);

    // The before-leg that makes the after-leg's null non-vacuous.
    const listed = await page(paths.settingsSessions, actor.cookie);
    expect(revokeLinkFor(listed, otherId)).not.toBeNull();

    const wanted = fakePassword(20);
    const { pane, form } = await passwordForm(actor.cookie);
    // Only the three fields typed: `revokeOtherSessions` rides exactly as drawn.
    const answered = await formPost(
      actionFor(pane, "change-password"),
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: wanted,
        confirmPassword: wanted,
      }),
      actor.cookie,
    );
    expect(answered.status).toBe(303);
    const back = answered.headers.get("Location") ?? "";
    expect(new URL(back, ORIGIN).pathname).toBe(paths.settings);
    expect(back).toContain("done=");

    // §13's "this one stays" is true from the owner's chair and false at the row level:
    // the id changes and the cookie is REPLACED in the same response.
    const fresh = sessionCookieOf(answered);
    expect(fresh).not.toBeNull();
    expect(await sessionIdOf(fresh ?? "")).not.toBe(before);

    const landed = await page(back, fresh ?? "");
    expect(landed).toContain("Password updated.");
    expect(landed).toContain("2 other session(s) were signed out — this one stays.");
    expect(landed).toContain(
      "App and agent tokens keep working: they do not derive from the password.",
    );

    // Every other way in is gone — the browser's old cookie, the other browser, the CLI.
    // The destination, not just the status: a redirect anywhere else — back onto /settings,
    // say — is not "signed out", and 302 alone cannot tell the two apart.
    for (const dead of [actor.cookie, bystander.cookie]) {
      const bounced = await get(paths.settings, dead);
      expect(bounced.status).toBe(302);
      expect(bounced.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);
    }
    expect((await whoami(device)).status).toBe(401);
    expect((await get(paths.settings, fresh ?? "")).status).toBe(200);

    // §13's "shows one session created just now", as the shell's own count rule.
    const after = await page(paths.settingsSessions, fresh ?? "");
    expect(revokeLinkFor(after, before)).toBeNull();
    expect(revokeLinkFor(after, otherId)).toBeNull();
    expect(after).not.toContain(before);
    expect(after).not.toContain(otherId);
    expect(markerOf(after, paths.settingsSessions)).toBe("1");
  });

  it(`§4/§13 · a password change derives nothing and revokes nothing in the token table: the app token and the agent token issued before it still authenticate afterwards — "App and agent tokens keep working: they do not derive from the password." made true rather than said`, async () => {
    const slug = uniqueSlug("pwapp");
    const agent = uniqueSlug("pwagt");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: agent, tokens: [{ as: "agent" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    // The app half's ceiling, stated: a `pmcp_app_` token's only door is the /connect
    // upgrade and this project has no sockets, so identity's own resolver stands in.
    const appRequest = () =>
      new Request(ORIGIN, { headers: { Authorization: `Bearer ${ns.tokens.app.token}` } });

    const beforeAgent = await whoami(ns.tokens.agent.token);
    expect(beforeAgent.status).toBe(200);
    expect(await beforeAgent.json()).toMatchObject({ principal: `agent:${agent}` });
    expect(await resolveAppToken(appRequest())).toMatchObject({ appId: ns.apps[slug].id });

    // The harshest change there is: the box left TICKED, which deletes every session.
    const wanted = fakePassword(20);
    const { pane, form } = await passwordForm(session.cookie);
    const answered = await formPost(
      actionFor(pane, "change-password"),
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: wanted,
        confirmPassword: wanted,
      }),
      session.cookie,
    );
    expect(answered.status).toBe(303);
    const landed = await page(answered.headers.get("Location") ?? "", sessionCookieOf(answered) ?? "");
    expect(landed).toContain(
      "App and agent tokens keep working: they do not derive from the password.",
    );

    const afterAgent = await whoami(ns.tokens.agent.token);
    expect(afterAgent.status).toBe(200);
    expect(await afterAgent.json()).toMatchObject({ principal: `agent:${agent}` });
    expect(await resolveAppToken(appRequest())).toMatchObject({ appId: ns.apps[slug].id });
  });

  it(`§13 · unticking Sign out my other sessions is the whole difference: the change succeeds, this session's id is unchanged, the other sessions still open pages, and the success copy carries no sessions sentence (the twin of the flag)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    // Built exactly as the ticked row builds them, so the two rows differ in ONE thing.
    const { actor, bystander, device, before } = await threeSessions(ns);

    const wanted = fakePassword(20);
    const { pane, form } = await passwordForm(actor.cookie);
    const answered = await formPost(
      actionFor(pane, "change-password"),
      unticked(
        typedInto(form, {
          currentPassword: SEEDED_OWNER_PASSWORD,
          newPassword: wanted,
          confirmPassword: wanted,
        }),
      ),
      actor.cookie,
    );
    expect(answered.status).toBe(303);
    const back = answered.headers.get("Location") ?? "";
    expect(new URL(back, ORIGIN).pathname).toBe(paths.settings);
    expect(back).toContain("done=");

    expect(await sessionIdOf(actor.cookie)).toBe(before);
    expect((await get(paths.apps, bystander.cookie)).status).toBe(200);
    expect((await whoami(device)).status).toBe(200);

    // Followed with the SAME cookie — nothing replaced it. Whether better-auth also sets
    // one when the flag is absent is its business and no §13 sentence, so it is not read.
    const landed = await page(back, actor.cookie);
    expect(landed).toContain("Password updated.");
    expect(landed).toContain(
      "App and agent tokens keep working: they do not derive from the password.",
    );
    // Non-vacuous because the ticked row next door renders exactly this.
    expect(landed).not.toContain("other session(s) were signed out");

    expect(await signsIn(ns.owner.username, wanted)).toBe(true);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(false);
  });
  it(`§13 · POST /settings/change-password without the CSRF field the pane rendered is 403 and the password is untouched — the old one still signs in · the same submission carrying it changes the password (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const before = await sessionIdOf(session.cookie);
    const { pane, form } = await passwordForm(session.cookie);
    const wanted = fakePassword(20);
    const filled = unticked(
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: wanted,
        confirmPassword: wanted,
      }),
    );

    // The shape of a cross-site post: everything the page drew EXCEPT its token.
    const stripped = { ...filled };
    delete stripped.csrf;
    const refused = await formPost(
      actionFor(pane, "change-password"),
      stripped,
      session.cookie,
    );
    expect(refused.status).toBe(403);
    expect(sessionCookieOf(refused)).toBeNull();
    expect(await sessionIdOf(session.cookie)).toBe(before);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, wanted)).toBe(false);

    // THE TWIN, without which a `throw 403` on the whole route would pass.
    const accepted = await formPost(actionFor(pane, "change-password"), filled, session.cookie);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("Location") ?? "").toContain("done=");
    expect(await signsIn(ns.owner.username, wanted)).toBe(true);
  });

  it(`§4/§13 · POST /settings/change-password with no credential at all — no cookie, no bearer — is bounced to /login and the password is untouched · the same submission under the owner's own fresh cookie reaches better-auth (the twin)`, async () => {
    // The SESSION third of §13's "session, recent authentication, CSRF" — the one a gate
    // that checked only recency would slip through.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const { pane, form } = await passwordForm(session.cookie);
    const wanted = fakePassword(20);
    const filled = unticked(
      typedInto(form, {
        currentPassword: SEEDED_OWNER_PASSWORD,
        newPassword: wanted,
        confirmPassword: wanted,
      }),
    );
    const target = actionFor(pane, "change-password");

    const anonymous = await formPost(target, filled);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);
    expect(sessionCookieOf(anonymous)).toBeNull();
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    const accepted = await formPost(target, filled, session.cookie);
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get("Location") ?? "").toContain(paths.settings);
  });

  it(`§4 · decision 39 · a day-old cookie is refused at both doors to a password change: straight at /api/auth/change-password it meets the mount's freshness guard (403 SESSION_NOT_FRESH, password untouched), and at /settings/change-password the hub's recent-auth gate never lets it reach better-auth`, async () => {
    // Both doors refuse the same stale session.
    // One app, because /apps is where a session with no recency left can still read its
    // own CSRF token and a namespace with no rows draws no form to read one off.
    const ns = await seedNamespace(env.DB, { apps: [{ slug: uniqueSlug("pwgate"), kind: "tunnel" }] });
    const stale = await seedOwnerSession(ns.owner);
    const fresh = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    const wanted = fakePassword(20);

    // LEG A: straight at better-auth's own mount, no Authorization header (so the
    // BEARER_ADMITTED guard never fires) — refused on the session's age (decision 39); the
    // per-endpoint list is fresh-auth.test.ts.
    const direct = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: stale.cookie },
        body: JSON.stringify({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted }),
      }),
    );
    expect(direct.status, await direct.clone().text()).toBe(403);
    expect(((await direct.json()) as { code?: string }).code).toBe("SESSION_NOT_FRESH");
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    // LEG B: the same cookie at the hub's own route, carrying its own real CSRF token
    // (read off /apps, which has no recency gate) — it never reaches better-auth.
    // The submission the pane RENDERED, filled — never hand-spelled field names, which
    // would keep this leg green through a rename the browser could not survive (§9 4b).
    const { pane, form } = await passwordForm(fresh.cookie);
    const gated = await formPost(
      actionFor(pane, "change-password"),
      {
        ...unticked(
          typedInto(form, {
            currentPassword: SEEDED_OWNER_PASSWORD,
            newPassword: wanted,
            confirmPassword: wanted,
          }),
        ),
        // The stale session's OWN token, so the refusal cannot be the CSRF check.
        csrf: bootstrapCsrfOf(await page(paths.apps, stale.cookie)),
      },
      stale.cookie,
    );
    expect(gated.status).toBe(302);
    expect(gated.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
  });

  it(`§4 · the day-old cookie that can post none of /settings's credential targets cannot post Update password either — the action read off the rendered pane, walked stale and fresh · a session signed in moments ago reaches better-auth with the same body (the twin)`, async () => {
    // /apps is where a stale session can still read its own CSRF token: the shell document
    // carries it in the bootstrap island behind no recency gate, whatever the namespace
    // holds. An app is seeded anyway, so the namespace is the one row 26's is.
    const ns = await seedNamespace(env.DB, { apps: [{ slug: uniqueSlug("pwstale"), kind: "tunnel" }] });
    const stale = await seedOwnerSession(ns.owner);
    const fresh = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);

    const { pane, form } = await passwordForm(fresh.cookie);
    const target = actionFor(pane, "change-password");
    expect(target).toBe(paths.auth.changePassword);
    // A deliberately WRONG current password throughout, so neither leg's success can move
    // the other's world and the two legs differ in exactly one thing: whose cookie.
    const wanted = fakePassword(20);
    const body = unticked(
      typedInto(form, {
        currentPassword: WRONG_PASSWORD,
        newPassword: wanted,
        confirmPassword: wanted,
      }),
    );

    // Each session's own real CSRF token, off /apps — so the refusal cannot be the CSRF
    // check answering instead of the gate.
    const refused = await formPost(
      target,
      { ...body, csrf: bootstrapCsrfOf(await page(paths.apps, stale.cookie)) },
      stale.cookie,
    );
    expect(refused.status).toBe(302);
    expect(refused.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);

    const reached = await formPost(
      target,
      { ...body, csrf: bootstrapCsrfOf(await page(paths.apps, fresh.cookie)) },
      fresh.cookie,
    );
    expect(reached.status).toBe(303);
    const back = reached.headers.get("Location") ?? "";
    expect(back).toContain(paths.settings);
    expect(back).toContain("failed=");

    // The debt case 26's DERIVED list owes (§9 rule 4a): the derivation's honesty check,
    // recorded here rather than claimed as this row's subject.
    expect(SETTINGS_CREDENTIAL_TARGETS.length).toBeGreaterThan(0);
    expect(SETTINGS_CREDENTIAL_TARGETS).toContain(target);
  });
});

/** How settings.tsx spells a passkey's stamp today — `Added <date> · <last used>`. §13
 *  pins only that the row carries an `added` field, never its wording, so the spelling is
 *  §7-incidental and lives behind one name: this is the single place the drift shows. */
const ADDED_STAMP = /Added ([^·]+)·/g;

describe(`§13 · the Two-factor, Passkeys and Sessions panes`, () => {
  // plan row 8, and the replacement for the row retired with it — that one was green on
  // data the ceremony never produces: a stored name and no aaguid. What the pane owes is
  // the authenticator's own report — a known AAGUID reading "Windows Hello", the all-zero
  // one privacy-preserving platforms send reading "Passkey" — with the empty pane the twin.
  it(
    `§13 · /settings/passkeys names a row the way the authenticator reported it: a passkey stored with a known AAGUID and no name lists as "Windows Hello", one with the all-zero AAGUID that privacy-preserving platforms report lists as "Passkey", the marker reads 2 and each row links its own Remove dialog · with none, the pane renders "No passkeys yet. Add one to sign in without a password." and the marker reads 0 (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      // The twin first, before anything is planted: the pane with none.
      const empty = await page(paths.settingsPasskeys, session.cookie);
      expect(textOf(empty)).toContain("No passkeys yet. Add one to sign in without a password.");
      expect(markerOf(empty, paths.settingsPasskeys)).toBe("0");

      // Exactly what a registration writes and the retired row never had: an AAGUID and no
      // name at all (the Add-passkey ceremony sends none). One model the plugin's own table
      // knows, and the all-zero value privacy-preserving platforms report instead.
      const known = await plantPasskey(ns.owner.userId, { aaguid: "08987058-cadc-4b81-b6e1-30de50dcbe96" });
      const anonymous = await plantPasskey(ns.owner.userId, { aaguid: "00000000-0000-0000-0000-000000000000" });

      const html = await page(paths.settingsPasskeys, session.cookie);
      expect(markerOf(html, paths.settingsPasskeys)).toBe("2");
      // Read off each row's OWN Remove dialog, whose title model.ts builds from the same
      // resolved name the row lists — so "Windows Hello" cannot be satisfied by the pane's
      // own chrome, and the two rows are told apart by the name each one carries.
      for (const [id, name] of [
        [known, "Windows Hello"],
        [anonymous, "Passkey"],
      ] as const) {
        const link = confirmLinkFor(html, "remove-passkey", id);
        expect(link, `the pane drew no Remove dialog for ${id}`).not.toBeNull();
        expect(textOf(await page(link ?? "", session.cookie))).toContain(`Remove passkey “${name}”?`);
      }
    },
  );

  // plan row 7. The Sessions pane names each session's client, and the device flow mints the
  // one client no browser can — so the row reads both rows off a single render: the CLI's
  // device-flow suffix beside the browser session's own client without it, and the rail's
  // Sessions marker counting the two.
  it(
    `§13 · a session minted by the device flow lists as "pmcp CLI · device flow" in the Sessions pane beside the browser session that rendered the page, which reads its own client with no device-flow suffix (the twin) — and the rail's Sessions marker counts both`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const browser = await seedOwnerSession(ns.owner);
      // The whole RFC 8628 walk, because /device/token is the one endpoint that stamps the
      // column — a row planted by hand would be the test asserting its own setup.
      await deviceFlowToken(browser.cookie);

      const listed = await page(paths.settingsSessions, browser.cookie);
      const text = textOf(listed);
      // The client no browser can be, with format.ts's suffix on it.
      expect(text).toContain("pmcp CLI · device flow");
      // The twin, on the same render: the browser session that drew this page sent no
      // User-Agent, so it reads the label an unnamed web session gets — and never the CLI's
      // label, nor the suffix, which a `source` stamped from a header would give it.
      expect(text).toContain("Unknown client");
      expect(text, "the browser session was labelled a device-flow one").not.toContain(
        "Unknown client · device flow",
      );
      expect(markerOf(listed, paths.settingsSessions)).toBe("2");
    },
  );

  it(`§13 · each passkey row carries its own added stamp: two passkeys with the same name and different createdAt render two different rows`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // Same name, different stamps: everything about these rows except the stamp is equal,
    // so a loader that dropped it — or stamped the render instant, which is what a null
    // `createdAt` produces today — renders one row twice.
    await plantPasskey(ns.owner.userId, { name: "YubiKey 5C", createdAt: "2026-01-08T17:40:00.000Z" });
    await plantPasskey(ns.owner.userId, { name: "YubiKey 5C", createdAt: "2026-03-12T09:14:00.000Z" });

    const html = await page(paths.settingsPasskeys, session.cookie);
    expect(markerOf(html, paths.settingsPasskeys)).toBe("2");
    // The row's own meta line, read as text: §13 gives the passkey row an `added` field,
    // and §7 makes how a date is SPELLED incidental — so this pins two stamps that differ
    // and nothing about either one's format.
    const added = [...textOf(html).matchAll(ADDED_STAMP)].map((match) => match[1].trim());
    // At LEAST two, never exactly two: a card a pane renders twice (as the sessions card
    // already is) draws each row's stamp twice, and that is not this row's subject.
    expect(added.length, "the pane drew no added stamps").toBeGreaterThanOrEqual(2);
    expect(new Set(added).size, "two passkeys with different stamps rendered one row twice").toBe(2);
  });
  it(`§5/§13 · identity.stampPasskeyUse writes §5's last_used_at for the credential id it names — and only that one — and the pane's row reads "last used …" only after it: before the stamp the pane says it of no passkey (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const credA = uniqueSlug("creda");
    const credB = uniqueSlug("credb");
    await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID", credentialId: credA });
    await plantPasskey(ns.owner.userId, { name: "YubiKey 5C", credentialId: credB });

    // LEG ONE, the twin that keeps leg two non-vacuous: neither row has ever been used.
    expect(await page(paths.settingsPasskeys, session.cookie)).not.toContain("last used");

    // An INJECTED clock, so the value written is known rather than merely non-null.
    const AT = 1_760_000_000_000;
    await stampPasskeyUse(credA, () => AT);
    expect(await lastUsedOf(credA)).toBe(AT);
    // Keyed by the credential the assertion named, not by the user who owns both.
    expect(await lastUsedOf(credB)).toBeNull();

    // LEG TWO: §5's own phrase, which is what proves the loader reads the hub's column.
    expect(await page(paths.settingsPasskeys, session.cookie)).toContain("last used");
  });
  it(`§13 · /settings/passkeys' Remove walks end to end as a browser walks it — the confirm link riding the pane's own URL, the dialog's form, the form-encoded POST, the redirect back to /settings/passkeys — and the row and its rail count are gone afterwards, while a guessed id draws no dialog at all (the twin)`, async () => {
    // Its own namespace and session: the marker below is an absolute number, so another
    // case's planted passkey must not be able to move it.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const id = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    const confirm = paths.settingsConfirm("passkeys", "remove-passkey", id);

    const listed = await page(paths.settingsPasskeys, session.cookie);
    expect(listed).toContain("MacBook Touch ID");
    expect(listed).toContain(confirm.replace(/&/g, "&amp;"));
    // Plan constraint 4 made observable: the dialog rides the pane, not the page root.
    expect(confirm.startsWith(paths.settingsPasskeys)).toBe(true);
    expect(markerOf(listed, paths.settingsPasskeys)).toBe("1");

    // The twin, read structurally rather than off the dialog's title (§13 quotes none):
    // a confirm naming no row on the pane is no dialog at all.
    const guessed = paths.settingsConfirm("passkeys", "remove-passkey", uniqueSlug("nope"));
    expect(formsPostingTo(await page(guessed, session.cookie), paths.auth.passkeyDelete)).toEqual([]);

    const dialog = await page(confirm, session.cookie);
    expect(formsPostingTo(dialog, paths.auth.passkeyDelete).length).toBeGreaterThan(0);
    const answered = await formPost(
      actionFor(dialog, "delete-passkey"),
      submissionOf(dialog),
      session.cookie,
    );
    expect(answered.status).toBe(303);
    const location = answered.headers.get("Location") ?? "";
    expect(location.startsWith(paths.settingsPasskeys)).toBe(true);
    expect(location).toContain("done=");

    const after = await page(paths.settingsPasskeys, session.cookie);
    expect(after).not.toContain("MacBook Touch ID");
    expect(after).not.toContain(confirm.replace(/&/g, "&amp;"));
    expect(markerOf(after, paths.settingsPasskeys)).toBe("0");
  });
  it(`§13/§9 · Add passkey is the one credential control that is not a form: /settings/passkeys names better-auth's own generate-register-options and verify-registration endpoints inside a script calling navigator.credentials.create, in no action= and no href= · every form the same page renders posts to a hub route under /settings (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const planted = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    // ONE document, and one that demonstrably HAS forms: the pane's own URL with its
    // Remove dialog open, which is where §13 puts the pane's only credential form.
    const html = await page(
      paths.settingsConfirm("passkeys", "remove-passkey", planted),
      session.cookie,
    );

    expect(html).toContain("Add passkey");
    expect(html).toContain(paths.auth.passkeyRegister);
    expect(html).toContain(paths.auth.passkeyVerifyRegistration);
    expect(html).toContain("navigator.credentials.create");
    // NOT A FORM AND NOT A LINK: neither endpoint is anywhere a browser could navigate.
    expect(inNavigableAttribute(html, paths.auth.passkeyRegister)).toBe(false);
    expect(inNavigableAttribute(html, paths.auth.passkeyVerifyRegistration)).toBe(false);

    // THE TWIN, on the same document. The shell's Sign out is the one posting form that
    // is not the pane's — layout.tsx draws it into every signed-in page — and it is a hub
    // translation route too, so it is named here rather than silently skipped.
    const actions = formsOn(html);
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(
        action.startsWith(paths.settings) || action === paths.auth.signOut,
        `${action} is not a hub route`,
      ).toBe(true);
      expect(action.startsWith(paths.auth.base), `${action} posts at better-auth's mount`).toBe(false);
    }
    const answered = await formPost(
      actionFor(html, "delete-passkey"),
      submissionOf(html),
      session.cookie,
    );
    expect(answered.status).toBe(303);
  });

  it(`§13 · /login's passkey button is live the same way — the page names generate-authenticate-options and verify-authentication in a script calling navigator.credentials.get, while its own username form still posts form-encoded to the hub's translation route (the twin)`, async () => {
    // No session exists, which is the whole point of the button.
    const html = await anonymousPage(paths.login);

    expect(html).toContain(paths.auth.passkeyAuthenticateOptions);
    expect(html).toContain(paths.auth.passkeyVerifyAuthentication);
    expect(html).toContain("navigator.credentials.get");
    expect(inNavigableAttribute(html, paths.auth.passkeyAuthenticateOptions)).toBe(false);
    expect(inNavigableAttribute(html, paths.auth.passkeyVerifyAuthentication)).toBe(false);
    for (const action of formsOn(html)) {
      expect(action.startsWith(paths.auth.base), `${action} posts at better-auth's mount`).toBe(false);
    }

    // The twin: this page's own credential form is still a form, posted at the hub.
    const signIn = actionFor(html, "username");
    expect(signIn.startsWith(paths.login)).toBe(true);
    expect(signIn).toBe(paths.auth.signIn);
  });
  it(`§13 · /settings/sessions lists every session under Client / Created / Last active, and the rail's Sessions marker is the number of rows the pane listed`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const a = await seedOwnerSession(ns.owner);
    const b = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const [aId, bId] = [await sessionIdOf(a.cookie), await sessionIdOf(b.cookie)];

    const html = await page(paths.settingsSessions, viewer.cookie);
    // §13's three column names. `Client` takes a word boundary: "Clients" is the rail's
    // Connected clients entry and the mobile pill's label, so a bare toContain("Client")
    // is true of every settings pane.
    expect(html).toMatch(/\bClient\b/);
    expect(html).toContain("Created");
    expect(html).toContain("Last active");
    // Every session listed — the two others by their revoke links, the viewer's own by the
    // badge, which is the only mark its row carries (§13: never revocable from its own row).
    expect(revokeLinkFor(html, aId)).not.toBeNull();
    expect(revokeLinkFor(html, bId)).not.toBeNull();
    // The badge as TEXT: `aria-current="page"` on the rail and `autocomplete=
    // "current-password"` on the landing pane both carry the word inside an attribute, so
    // a raw-HTML match is true of every settings pane. Stripped of tags, only the badge is.
    expect(textOf(html)).toMatch(/\bcurrent\b/);
    // DISTINCT ids: the sessions card renders twice into one document.
    const revocable = revocableIds(html);
    expect(revocable.size).toBe(2);
    expect(markerOf(html, paths.settingsSessions)).toBe(String(revocable.size + 1));
  });

  // The owner's live pane read "Unknown client" on every browser row (2026-09-03): /login's
  // translation rebuilt the request with only the cookie, so better-auth stored "" as the
  // session's User-Agent and nothing was left to name. The fix is on both sides of that
  // seam — identity forwards the header, model reads a label out of it — and this row
  // walks the whole seam as a browser does: three form sign-ins, one pane.
  it(`§13 · the Client column names the browser and system a web session was signed in from — /login's translation forwards the browser's User-Agent to better-auth, so a Chrome-on-Windows sign-in through the form lists as "Chrome on Windows" and a Safari-on-iPhone one as "Safari on iPhone", never the raw string · a sign-in that sent no User-Agent lists as "Unknown client" (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    await seedOwnerCredential(ns.owner.userId);
    // /login's own form, posted as a browser posts it — `formPost` minus the header this
    // row is about, because the header is the variable.
    const signIn = async (userAgent?: string): Promise<string> => {
      const answered = await call(
        new Request(`${ORIGIN}${paths.auth.signIn}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: ORIGIN,
            ...(userAgent === undefined ? {} : { "User-Agent": userAgent }),
          },
          body: new URLSearchParams({
            username: ns.owner.username,
            password: SEEDED_OWNER_PASSWORD,
          }).toString(),
        }),
      );
      const cookie = sessionCookieOf(answered);
      expect(cookie, `sign-in with User-Agent ${userAgent ?? "(none)"}`).not.toBeNull();
      return cookie ?? "";
    };
    const chrome = await signIn(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
    );
    await signIn(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    );
    await signIn();

    const text = textOf(await page(paths.settingsSessions, chrome));
    // Chrome's string also says "Safari" and "Mac OS X" is in the iPhone's: the labels
    // are what the lists picked, so a parse that took the first or last token would
    // read something else here.
    expect(text).toContain("Chrome on Windows");
    expect(text).toContain("Safari on iPhone");
    expect(text).toContain("Unknown client");
    expect(text).not.toContain("Mozilla/");
    expect(markerOf(await page(paths.settingsSessions, chrome), paths.settingsSessions)).toBe("3");
  });

  it(`§13 · the session rendering /settings/sessions is badged current and offers no Revoke — no link on its row, and its own ?confirm=revoke-session draws no dialog · every other session's row carries both (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const other = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const [currentId, otherId] = [await sessionIdOf(viewer.cookie), await sessionIdOf(other.cookie)];

    const html = await page(paths.settingsSessions, viewer.cookie);
    // As TEXT, so the positive precondition guarding the refusal below cannot be satisfied
    // by the rail's `aria-current` — a pane listing no session at all would then pass it.
    expect(textOf(html)).toMatch(/\bcurrent\b/);
    // The refusal, on the row AND on the dialog route — "never revocable from its own row"
    // is not a missing link that a hand-typed URL walks around.
    expect(revokeLinkFor(html, currentId)).toBeNull();
    const own = paths.settingsConfirm("sessions", "revoke-session", currentId);
    expect(formsPostingTo(await page(own, viewer.cookie), paths.auth.sessionRevoke)).toEqual([]);

    // The twin, same page and same helpers: another session's row carries both.
    const link = revokeLinkFor(html, otherId);
    expect(link).not.toBeNull();
    const dialog = await page(link ?? "", viewer.cookie);
    const forms = formsPostingTo(dialog, paths.auth.sessionRevoke);
    expect(forms.length).toBeGreaterThan(0);
    expect(forms[0].id).toBe(otherId);
  });
  it(`§4/§13 · /settings/sessions' Revoke walks end to end as a browser walks it — the confirm link on the pane's own URL, the rendered form, the form-encoded POST, the redirect back to /settings/sessions — and the session it named is gone from the listing and from the rail count afterwards while the current one still opens the page`, async () => {
    const doomed = await seedOwnerSession(world.ns.owner);
    // Resolved BEFORE the revoke: afterwards the cookie names no session, which is the
    // postcondition rather than a way to ask for the id.
    const doomedId = await sessionIdOf(doomed.cookie);
    const listed = await page(paths.settingsSessions);
    const confirm = revokeLinkFor(listed, doomedId);
    expect(confirm, "the pane rendered no revoke link for the second session").not.toBeNull();
    expect((confirm ?? "").startsWith(paths.settingsSessions)).toBe(true);
    const before = markerOf(listed, paths.settingsSessions);

    const dialog = await page(confirm ?? "");
    const answered = await formPost(
      actionFor(dialog, "revoke-session"),
      submissionOf(dialog),
      world.session.cookie,
    );
    expect(answered.status).toBe(303);
    const location = answered.headers.get("Location") ?? "";
    // The redirect-back flash says which it was, so a refusal fails HERE with its reason
    // rather than three lines later as an unexplained listing.
    expect(location.startsWith(paths.settingsSessions)).toBe(true);
    expect(location).toContain("done=");

    const after = await page(paths.settingsSessions);
    expect(after).not.toContain(doomedId);
    expect(textOf(after)).toMatch(/\bcurrent\b/);
    expect(markerOf(after, paths.settingsSessions)).toBe(String(Number(before) - 1));
    expect((await get(paths.settingsSessions, doomed.cookie)).status).toBe(302);
  });

  it(`§13 · Revoke all others walks end to end through better-auth's /revoke-other-sessions: every other session is gone and its cookie opens nothing, while the CURRENT session's id is unchanged, its cookie unreplaced and still opening the pane — the opposite contract from the Password pane's flag, which replaces it`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const a = await seedOwnerSession(ns.owner);
    const b = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const [aId, bId, viewerId] = [
      await sessionIdOf(a.cookie),
      await sessionIdOf(b.cookie),
      await sessionIdOf(viewer.cookie),
    ];

    const listed = await page(paths.settingsSessions, viewer.cookie);
    expect(markerOf(listed, paths.settingsSessions)).toBe("3");
    const confirm = confirmLinksOn(listed).find((href) => href.includes("revoke-other-sessions"));
    expect(confirm, "the pane rendered no Revoke all others link").toBeDefined();
    expect((confirm ?? "").startsWith(paths.settingsSessions)).toBe(true);

    const dialog = await page(confirm ?? "", viewer.cookie);
    const answered = await formPost(
      actionFor(dialog, "revoke-other-sessions"),
      submissionOf(dialog),
      viewer.cookie,
    );
    expect(answered.status).toBe(303);
    const location = answered.headers.get("Location") ?? "";
    expect(location.startsWith(paths.settingsSessions)).toBe(true);
    expect(location).toContain("done=");

    // THE CONTRAST with the Password pane's checkbox, three ways. (1) This session is not
    // replaced — stated as "never a cookie naming a different session", so a same-token
    // refresh cookie cannot fail the row for the wrong reason.
    const replacement = sessionCookieOf(answered);
    if (replacement !== null) expect(replacement).toBe(viewer.cookie);
    // (2) its id is unchanged, and (3) it still opens the pane.
    expect(await sessionIdOf(viewer.cookie)).toBe(viewerId);
    expect((await get(paths.settingsSessions, viewer.cookie)).status).toBe(200);

    const after = await page(paths.settingsSessions, viewer.cookie);
    for (const id of [aId, bId]) {
      expect(after).not.toContain(id);
      expect(revokeLinkFor(after, id)).toBeNull();
    }
    expect(markerOf(after, paths.settingsSessions)).toBe("1");
    expect((await get(paths.settingsSessions, a.cookie)).status).toBe(302);
    expect((await get(paths.settingsSessions, b.cookie)).status).toBe(302);
  });

  it(`§13 · a CLI session is listed on /settings/sessions and revocable from it: after a device flow the pane's marker goes up by one and carries one more revoke link, and revoking that row kills the CLI's bearer while the browser session still opens the pane (the twin)`, async () => {
    // §13 says "every web and CLI session", and every other row here proves the universal
    // over browser sessions alone. Only the row's LABEL is unassertable (nothing
    // better-auth stores separates a device-flow session from a browser one); listed and
    // revocable is not.
    const ns = await seedNamespace(env.DB, {});
    const viewer = await seedOwnerSession(ns.owner);
    const listedBefore = await page(paths.settingsSessions, viewer.cookie);
    const before = revocableIds(listedBefore);
    expect(markerOf(listedBefore, paths.settingsSessions)).toBe("1");

    // The real RFC 8628 exchange, which mints a real session row for this owner.
    const token = await deviceFlowToken(viewer.cookie);
    const listedAfter = await page(paths.settingsSessions, viewer.cookie);
    const added = [...revocableIds(listedAfter)].filter((id) => !before.has(id));
    expect(added.length, "the device flow added no revocable row").toBe(1);
    expect(markerOf(listedAfter, paths.settingsSessions)).toBe("2");
    // The PRINCIPAL, not just the status (case 28's own call): a bearer that authenticated
    // as somebody else would otherwise satisfy the pre-revoke leg.
    const answeredWhoami = await whoami(token);
    expect(answeredWhoami.status).toBe(200);
    expect(await answeredWhoami.json()).toMatchObject({ principal: `user:${ns.owner.username}` });

    const dialog = await page(
      paths.settingsConfirm("sessions", "revoke-session", added[0]),
      viewer.cookie,
    );
    const answered = await formPost(
      actionFor(dialog, "revoke-session"),
      submissionOf(dialog),
      viewer.cookie,
    );
    expect(answered.status).toBe(303);
    expect((await whoami(token)).status).toBe(401);
    // The twin: revoking the CLI's row took the CLI's session and nothing else.
    expect((await get(paths.settingsSessions, viewer.cookie)).status).toBe(200);
  });

  it(`§13 · /settings/two-factor is the Two-factor pane's one URL: it renders the card, its forms post to the same paths.auth targets as before, and its Disable confirm rides /settings/two-factor`, async () => {
    // Substance deliberately not re-pinned here: case 27 keeps the TOTP acceptance claim,
    // re-pointed to this URL. What this row owns is the pane's identity.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);

    const notEnrolled = await page(paths.settingsTwoFactor, session.cookie);
    expect(formsPostingTo(notEnrolled, paths.auth.totpEnable).length).toBeGreaterThan(0);

    // The one state no route reaches (settingsProps never renders the mid-enrollment card).
    await enrollTwoFactor(ns.owner.userId);
    const enrolled = await page(paths.settingsTwoFactor, session.cookie);
    expect(formsPostingTo(enrolled, paths.auth.backupCodesGenerate).length).toBeGreaterThan(0);
    const disable = paths.settingsConfirm("two-factor", "disable-two-factor");
    expect(enrolled).toContain(disable);
    expect(disable.startsWith(paths.settingsTwoFactor)).toBe(true);
    const dialog = await page(disable, session.cookie);
    expect(formsPostingTo(dialog, paths.auth.totpDisable).length).toBeGreaterThan(0);

    // Scoped to the RAIL: the pill row draws the same routes and marks its active pill too.
    const current = railEntries(enrolled, RAIL_NAV_LABEL).filter((entry) => entry.current);
    expect(current.map((entry) => entry.href)).toEqual([paths.settingsTwoFactor]);
  });

  it(`§9/§13 · every control the /settings panes render is claimed: the Sign-in panes and Sessions render only better-auth credential targets and no ops-backed form (§13's pinned exception, per pane), the two Access panes front ops keys, every ?confirm= link rides the pane that drew it, and Add passkey is the single enumerated exclusion`, async () => {
    // §9 rule 4a's totality case, and the replacement for row 18 — whose "/settings renders
    // no ops-backed form at all" stopped being true the moment Tokens and Clients became
    // panes. The claim is now PER PANE, so a Sessions pane that started fronting
    // `token_revoke` fails here.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent", tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    await seedOwnerSession(ns.owner);
    await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    await consentOnce(ns, session.cookie, "agent");

    const CREDENTIAL_PANES: readonly string[] = [
      paths.settings,
      paths.settingsTwoFactor,
      paths.settingsPasskeys,
      paths.settingsSessions,
    ];
    const ACCESS_PANES: readonly string[] = [paths.settingsTokens, paths.settingsClients];

    for (const pane of PANES) {
      const bare = await page(pane, session.cookie);
      const confirms = confirmLinksOn(bare);
      // (4) Every confirm link a pane renders rides that pane's own path.
      for (const href of confirms) {
        expect(new URL(href, ORIGIN).pathname, `${href} was drawn on ${pane}`).toBe(pane);
      }
      // A pane's controls include the ones that exist only under its own `?confirm=`.
      const actions: string[] = [...formsOn(bare)];
      for (const href of confirms) actions.push(...formsOn(await page(href, session.cookie)));

      const fronted = actions
        .map((action) => action.split("?")[0].split("/").filter(Boolean).pop() ?? "")
        .filter((op) => Object.prototype.hasOwnProperty.call(ops, op));
      if (CREDENTIAL_PANES.includes(pane)) {
        // (1) The pinned parity exception, per pane.
        expect(fronted, `${pane} fronts an ops key`).toEqual([]);
        for (const action of actions) {
          const op = action.split("?")[0].split("/").filter(Boolean).pop() ?? "";
          expect(BETTER_AUTH_ACTIONS.has(op), `${pane} posts to "${op}"`).toBe(true);
        }
      }
      // (2) The two Access panes DO front ops keys.
      if (ACCESS_PANES.includes(pane)) expect(fronted.length, `${pane} fronts no ops key`).toBeGreaterThan(0);
      // (3) Nothing on any pane posts at better-auth's own mount, which would answer 415.
      for (const action of actions) {
        expect(action.startsWith(paths.auth.base), `${pane} posts at ${action}`).toBe(false);
      }
    }

    // The two /settings renders no GET produces: `credential`'s reveals answer 200 with the
    // pane rather than redirecting (a secret cannot ride a URL, §15), and the enrolment
    // card's verify form is a /settings control this walk would otherwise never see — a
    // hole in the totality, not a named exclusion. Enable first: the fresh set is minted
    // against the row enable creates. Checks (1) and (3) again, over what each 200 drew.
    const revealCsrf = csrfOf(await page(paths.settingsTwoFactor, session.cookie));
    for (const target of [paths.auth.totpEnable, paths.auth.backupCodesGenerate]) {
      // Regenerate only answers for an owner whose factor is LIVE, which no page can make
      // it (the verify that flips the column needs a code derived from the minted secret).
      if (target === paths.auth.backupCodesGenerate) await enrollTwoFactor(ns.owner.userId);
      const revealed = await formPost(
        target,
        { csrf: revealCsrf, password: SEEDED_OWNER_PASSWORD },
        session.cookie,
      );
      expect(revealed.status, `POST ${target}`).toBe(200);
      const drew = formsOn(await revealed.text());
      for (const action of drew) {
        const op = action.split("?")[0].split("/").filter(Boolean).pop() ?? "";
        expect(Object.prototype.hasOwnProperty.call(ops, op), `${target}'s reveal fronts "${op}"`).toBe(false);
        expect(BETTER_AUTH_ACTIONS.has(op), `${target}'s reveal posts to "${op}"`).toBe(true);
        expect(action.startsWith(paths.auth.base), `${target}'s reveal posts at ${action}`).toBe(false);
      }
    }

    // THE EXCLUSION, enumerated and then spent: the Add-passkey ceremony is the one
    // credential POST under /settings that is not a form, and the ceremony row claims it.
    const passkeysPane = await page(paths.settingsPasskeys, session.cookie);
    for (const endpoint of [paths.auth.passkeyRegister, paths.auth.passkeyVerifyRegistration]) {
      // Present FIRST, or deleting the ceremony script outright would satisfy the negative.
      expect(passkeysPane, `${endpoint} is not named on the pane at all`).toContain(endpoint);
      expect(inNavigableAttribute(passkeysPane, endpoint), `${endpoint} is navigable`).toBe(false);
    }
  });

  // plan row 9. Its two named traps, either of which would make a status-only assertion green
  // for the wrong reason: better-auth's router-level originCheckMiddleware 403s a cookie-bearing
  // POST with no Origin as MISSING_OR_NULL_ORIGIN, and better-call validates the body schema
  // before any `use` middleware runs, so a malformed body 400s before the freshness gate does.
  it(
    `§4 · a day-old cookie is refused at BOTH passkey register endpoints with better-auth's SESSION_NOT_FRESH code — the GET options and the POST verify, the POST carrying an Origin so the refusal is the freshness gate and not the origin check, and a body that satisfies the endpoint's schema so it is not the validator either · from a session signed in moments ago the same two calls get past that gate, the GET answering 200 with a challenge and the POST failing the ceremony itself (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const stale = await seedOwnerSession(ns.owner);
      const fresh = await seedOwnerSession(ns.owner);
      await ageSession(stale.token);

      // NOT through callAuthResponse, which sets `origin` itself and would hide the first
      // trap: these are the ceremony's own calls, made the way its browser script makes
      // them. The body satisfies verify-registration's schema (`response`), so a refusal
      // cannot be better-call's validator answering before any middleware runs.
      const options = (cookie: string): Promise<Response> =>
        call(new Request(`${ORIGIN}${paths.auth.passkeyRegister}`, { headers: { Cookie: cookie } }));
      const verify = (cookie: string): Promise<Response> =>
        call(
          new Request(`${ORIGIN}${paths.auth.passkeyVerifyRegistration}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: cookie },
            body: JSON.stringify({ response: {} }),
          }),
        );
      /** better-auth's own name for the refusal — the CODE and never the status, because
       *  the two traps above are both 403s too. */
      const codeOf = async (response: Response): Promise<string> => {
        const body = (await response.json().catch(() => null)) as { code?: unknown } | null;
        return typeof body?.code === "string" ? body.code : "";
      };

      expect(await codeOf(await options(stale.cookie)), `GET ${paths.auth.passkeyRegister}`).toBe(
        "SESSION_NOT_FRESH",
      );
      expect(
        await codeOf(await verify(stale.cookie)),
        `POST ${paths.auth.passkeyVerifyRegistration}`,
      ).toBe("SESSION_NOT_FRESH");

      // The twin: the same two calls from a session signed in moments ago get PAST that
      // gate — the options endpoint answers a challenge, and the verify gets far enough to
      // fail the ceremony itself rather than the freshness check.
      const challenged = await options(fresh.cookie);
      expect(challenged.status).toBe(200);
      expect((await challenged.json()) as Record<string, unknown>).toHaveProperty("challenge");
      expect(await codeOf(await verify(fresh.cookie))).not.toBe("SESSION_NOT_FRESH");
    },
  );
});

describe(`§13/§15 · /settings/two-factor — the enrolment journey, in place`, () => {
  // The journey has ONE entrance and no other: /settings never renders the enrolment card
  // on a GET (settingsProps has no producer for it), so every row below starts by posting
  // the pane's own Enable form and reading the 200 that answers with the card.

  /**
   * The enrolment card as the pane's own Enable form produces it — the password typed into
   * the form the not-enrolled arm drew, posted as a browser posts it. The whole Response is
   * handed back rather than its body, because "carries no Location" is one of the claims.
   */
  async function enable(cookie: string): Promise<Response> {
    const forms = formsPostingTo(await page(paths.settingsTwoFactor, cookie), paths.auth.totpEnable);
    expect(forms.length, "the Two-factor pane rendered no Enable two-factor form").toBeGreaterThan(0);
    return formPost(paths.auth.totpEnable, typedInto(forms[0], { password: SEEDED_OWNER_PASSWORD }), cookie);
  }

  /** The verify form the enrolment card drew, as a browser would submit it untouched — the
   *  CSRF token, the two hidden carriers and the stitched `code` field, each at the value
   *  the page put there. */
  function verifyForm(html: string): Record<string, string> {
    const forms = formsPostingTo(html, paths.auth.totpVerifySettings);
    expect(forms.length, "the enrolment card drew no verify form").toBeGreaterThan(0);
    return forms[0];
  }

  /** The `secret` parameter of one card's own otpauth URI — better-auth's unpadded base32,
   *  which is both what the QR encodes and what an authenticator is typed. */
  function secretOf(form: Record<string, string>): string {
    const uri = new URL(form.totpuri ?? "");
    expect(uri.protocol, "the verify form carries no otpauth URI").toBe("otpauth:");
    expect(uri.host).toBe("totp");
    const secret = uri.searchParams.get("secret") ?? "";
    expect(secret, "the otpauth URI names no secret").not.toBe("");
    return secret;
  }

  /** How settings.tsx spells the manual-entry line today — the same secret, grouped for
   *  reading aloud. §13 pins that the secret is readable by hand, never the element, so
   *  this is the single place that spelling drifts. */
  function groupedSecretOn(html: string): string {
    const line = /<div class="secret">([^<]*)<\/div>/.exec(html)?.[1];
    expect(line, "the card drew no grouped secret").not.toBeUndefined();
    return line ?? "";
  }

  /** The QR's own `src`, which §15 requires to be self-contained rather than a fetch. */
  function qrSrcOn(html: string): string {
    const src = /<img[^>]*\bsrc="(data:[^"]*)"/.exec(html)?.[1];
    expect(src, "the card drew no data: image").not.toBeUndefined();
    return src ?? "";
  }

  /** Every code a reveal drew, read off the `data-code` element each one sits in — that
   *  attribute is what the Copy control's own selector reads, so this walk returns the set
   *  the handler would copy rather than a second, independent reading of the page. */
  function revealedCodesOn(html: string): string[] {
    return [...html.matchAll(/<[^>]*\bdata-code="[^"]*"[^>]*>([\s\S]*?)</g)].map((chip) => textOf(chip[1]));
  }

  /** The six code boxes one OTP card drew, as the tags they are — found through the
   *  `data-otp` hook the shared script keys off rather than through their styling. */
  function otpBoxesOn(html: string): string[] {
    const row = /<div\b[^>]*\bdata-otp="[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html);
    return row === null ? [] : [...row[1].matchAll(/<input\b[^>]*>/g)].map((box) => box[0]);
  }

  /** Every inline script one page embedded, as its text. */
  function scriptsOn(html: string): string[] {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((script) => script[1]);
  }

  /** The ONE stitching script an OTP card embeds, found by the hidden field it writes —
   *  row 4's "the same handler text" is an equality between two renders, so the harvest
   *  names what the script does and never where it sits. */
  function otpScriptOn(html: string): string {
    const found = scriptsOn(html).filter((body) => body.includes("data-otp-value"));
    expect(found.length, "the page embedded no single OTP stitching script").toBe(1);
    return found[0];
  }

  // plan row 1. Answering in place gives the minted secret exactly one carrier, this body, so
  // the row reads the grouped line, the verify form's hidden totpuri and the QR against the
  // "secret" parameter of that same answer's own otpauth URI — and the pane's next GET, the
  // state no route reaches today, is the twin that draws none of it.
  it(
    `§13/§15 · POST /settings/two-factor/enable with the owner's own password answers 200 rendering the setup card in place — the secret better-auth minted reaches the page as the grouped line and again as the verify form's hidden totpuri, both equal to the "secret" parameter of that same answer's otpauth URI, beside a QR served as a data:image/svg+xml URI and the ten backup codes from the same answer — while the answer carries no Location and the pane's own next GET draws the not-enrolled arm with the secret, the codes and the QR nowhere in it (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      const answered = await enable(session.cookie);
      expect(answered.status, `POST ${paths.auth.totpEnable}`).toBe(200);
      // In place, so there is no redirect for the secret to ride at all (§15).
      expect(answered.headers.get("Location"), "the enable answer set a Location").toBeNull();
      const card = await answered.text();

      const secret = secretOf(verifyForm(card));
      // The grouped line is the SAME secret, spaced — not a second one minted for display,
      // which is exactly what an owner typing it into an authenticator would discover.
      expect(groupedSecretOn(card).replace(/\s/g, "")).toBe(secret);
      expect(qrSrcOn(card).startsWith("data:image/svg+xml"), "the QR is not an inline SVG").toBe(true);
      const codes = revealedCodesOn(card);
      expect(codes.length, "the card drew no ten backup codes").toBe(10);

      // The twin: the pane's own next GET is the not-enrolled arm, and nothing of the
      // enrolment survives into it — better-auth will not repeat any of it.
      const next = await page(paths.settingsTwoFactor, session.cookie);
      expect(
        formsPostingTo(next, paths.auth.totpEnable).length,
        "the next GET did not draw the not-enrolled arm",
      ).toBeGreaterThan(0);
      expect(next, "the secret survived into the pane's next GET").not.toContain(secret);
      expect(next, "an otpauth URI survived into the pane's next GET").not.toContain("otpauth:");
      expect(next, "the QR survived into the pane's next GET").not.toContain("data:image/svg+xml");
      for (const code of codes) expect(next, `${code} survived into the pane's next GET`).not.toContain(code);
    },
  );

  // plan row 2. Rendering in place is what keeps the secret and the codes off a URL; this row
  // is the negative that makes it structural rather than incidental — the secret and all ten
  // codes in the bodies, no Location on either answer, and no href or form action on either
  // render carrying a "secret", an otpauth: URI or any code from the set.
  it(
    `§13/§15 · nothing on the enrolment journey puts the secret or a backup code on a URL: the enable answer and the verify refusal both carry the secret and all ten codes in their bodies, and neither sets a Location, and no href or form action either render draws carries a "secret", an otpauth: or any code from the set`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      const enabled = await enable(session.cookie);
      const card = await enabled.text();
      const form = verifyForm(card);
      const secret = secretOf(form);
      const codes = revealedCodesOn(card);
      expect(codes.length).toBe(10);

      // The refusal redraws the same enrolment, so it is the second body that holds both —
      // and the one a hand-written URL would be easiest to smuggle into.
      const refused = await formPost(
        paths.auth.totpVerifySettings,
        typedInto(form, { code: "000000" }),
        session.cookie,
      );
      const redrawn = await refused.text();

      for (const [name, body, response] of [
        ["the enable answer", card, enabled],
        ["the verify refusal", redrawn, refused],
      ] as const) {
        expect(response.status, name).toBe(200);
        expect(response.headers.get("Location"), `${name} set a Location`).toBeNull();
        // Present FIRST: a render that drew neither would satisfy every negative below.
        expect(body, `${name} lost the secret`).toContain(secret);
        for (const code of codes) expect(body, `${name} lost ${code}`).toContain(code);
        expect(inNavigableAttribute(body, "secret"), `${name} put a secret on a URL`).toBe(false);
        expect(inNavigableAttribute(body, "otpauth:"), `${name} put an otpauth URI on a URL`).toBe(false);
        for (const code of codes) {
          expect(inNavigableAttribute(body, code), `${name} put ${code} on a URL`).toBe(false);
        }
      }
    },
  );

  // plan row 3. Its named trap: a successful verify DELETES the session it ran under and mints
  // a new one, and `redirectWith` forwards those Set-Cookie headers onto the 303 — so the
  // cookie the test signed in with is dead the moment the POST returns and a follow-up GET
  // with it bounces to /login. The twin parses the new cookie off the 303 with sessionCookieOf.
  it(
    `§13 · a wrong code posted to /settings/two-factor/verify-totp answers 200 redrawing the SAME enrolment — byte-identical secret, the boxes aria-invalid, better-auth's own "Invalid code" on the card, the ten codes still shown — and twoFactorEnabled is still 0 · the code generated from that same secret answers 303 and re-issues the session cookie, and the pane read with THAT cookie renders the enabled arm with the codes gone (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      const card = await (await enable(session.cookie)).text();
      const form = verifyForm(card);
      const secret = secretOf(form);
      const codes = revealedCodesOn(card);

      const refused = await formPost(
        paths.auth.totpVerifySettings,
        typedInto(form, { code: "000000" }),
        session.cookie,
      );
      expect(refused.status, `POST ${paths.auth.totpVerifySettings}`).toBe(200);
      const redrawn = await refused.text();
      // THE SAME enrolment, byte for byte: a redraw that called /two-factor/enable again
      // would answer with a fresh secret and silently invalidate the QR already scanned.
      expect(secretOf(verifyForm(redrawn))).toBe(secret);
      expect(groupedSecretOn(redrawn)).toBe(groupedSecretOn(card));
      const boxes = otpBoxesOn(redrawn);
      expect(boxes.length, "the redraw drew no box row").toBe(6);
      for (const box of boxes) expect(box, "a box is not aria-invalid").toContain(`aria-invalid="true"`);
      // better-auth's own sentence, not one this hub wrote for it.
      expect(textOf(redrawn)).toContain("Invalid code");
      expect(revealedCodesOn(redrawn), "the refusal cost the owner the codes").toEqual(codes);
      expect(await twoFactorEnabledOf(ns.owner.userId), "a wrong code enabled the factor").toBe(0);

      // The twin: the six digits an authenticator would show for that same secret, played
      // by the harness because nothing in the tree can produce them.
      const accepted = await formPost(
        paths.auth.totpVerifySettings,
        typedInto(form, { code: await totpCode(secret) }),
        session.cookie,
      );
      expect(accepted.status).toBe(303);
      // The trap this row exists for: better-auth deleted the session this ran under and
      // minted a new one, and `redirectWith` forwarded it — so the cookie the case signed
      // in with is dead, and the pane has to be read with the one the 303 set.
      const rotated = sessionCookieOf(accepted);
      expect(rotated, "the successful verify re-issued no session cookie").not.toBeNull();
      expect(rotated).not.toBe(session.cookie);
      const enabledArm = await page(paths.settingsTwoFactor, rotated ?? "");
      expect(
        formsPostingTo(enabledArm, paths.auth.backupCodesGenerate).length,
        "the pane did not draw the enabled arm",
      ).toBeGreaterThan(0);
      expect(revealedCodesOn(enabledArm), "the enabled arm still showed the codes").toEqual([]);
    },
  );

  // plan row 4. One shared component, two consumers — the settings enrolment card and /login's
  // TOTP challenge — pinned on the field better-auth actually reads: a single "code". Today's
  // pane posts digit0…digit5 and could never verify, which is the twin's half.
  it(
    `§13 · the six boxes are stitched into the one field better-auth reads: the settings enrolment card and /login's TOTP challenge both carry data-otp-form and both render the shared component's hidden [data-otp-value] input, its six [data-otp] boxes and the same handler text, and the settings card posts a "code" field · neither card posts a digit0 field, which is what a code typed into today's pane sends (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);
      const card = await (await enable(session.cookie)).text();
      const challenge = await anonymousPage(`${paths.login}?step=totp`);

      for (const [name, html] of [
        ["the settings enrolment card", card],
        ["/login's TOTP challenge", challenge],
      ] as const) {
        // On the FORM, which is what the script looks for first — the two forms differ in
        // action and hidden fields, so the hook is each caller's own to carry.
        expect(/<form\b[^>]*\bdata-otp-form=/.test(html), `${name}'s form carries no data-otp-form`).toBe(true);
        expect(/<input\b[^>]*\bdata-otp-value=/.test(html), `${name} renders no hidden [data-otp-value]`).toBe(true);
        expect(otpBoxesOn(html).length, `${name}'s box row`).toBe(6);
      }
      // ONE definition rather than two copies: a second copy is exactly how G30 happened.
      expect(otpScriptOn(card)).toBe(otpScriptOn(challenge));

      const loginForms = formsPostingTo(challenge, paths.auth.totpVerify);
      expect(loginForms.length, "/login drew no TOTP challenge form").toBeGreaterThan(0);
      for (const [name, form] of [
        ["the settings card", verifyForm(card)],
        ["/login's card", loginForms[0]],
      ] as const) {
        // The field better-auth's verify-totp actually reads …
        expect(Object.keys(form), `${name} posts no "code" field`).toContain("code");
        // … and the twin: the six names a code typed into today's pane sends instead, which
        // better-auth reads as no code at all.
        expect(Object.keys(form), `${name} still posts digit0`).not.toContain("digit0");
      }
    },
  );

  // plan row 5. The reveal happens in place too, which is what makes "fresh" checkable: none of
  // the ten codes the enrolment showed may appear in the new set. Its twins are the pane's next
  // GET, which reveals nothing, and the wrong password, which redirects with failed= instead.
  it(
    `§13 · Regenerate backup codes answers 200 revealing a fresh set in place — ten codes, none of them from the set the enrolment showed — while the pane's next GET reveals none and a wrong password redirects with failed= instead (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);
      // The enrolment's own set, which is what "fresh" is measured against.
      const enrolled = revealedCodesOn(await (await enable(session.cookie)).text());
      expect(enrolled.length).toBe(10);
      // The enabled arm is the only one that draws the Regenerate control at all.
      await enrollTwoFactor(ns.owner.userId);

      const forms = formsPostingTo(
        await page(paths.settingsTwoFactor, session.cookie),
        paths.auth.backupCodesGenerate,
      );
      expect(forms.length, "the enabled arm rendered no Regenerate backup codes form").toBeGreaterThan(0);
      const answered = await formPost(
        paths.auth.backupCodesGenerate,
        typedInto(forms[0], { password: SEEDED_OWNER_PASSWORD }),
        session.cookie,
      );
      expect(answered.status, `POST ${paths.auth.backupCodesGenerate}`).toBe(200);
      expect(answered.headers.get("Location"), "the regenerate answer set a Location").toBeNull();
      const fresh = revealedCodesOn(await answered.text());
      expect(fresh.length, "the reveal drew no ten codes").toBe(10);
      expect(
        fresh.filter((code) => enrolled.includes(code)),
        "a regenerated code was one the enrolment already showed",
      ).toEqual([]);

      // The twins: the pane's own next GET reveals none …
      expect(revealedCodesOn(await page(paths.settingsTwoFactor, session.cookie))).toEqual([]);
      // … and a wrong password has no set to show, so it takes the flash instead.
      const refused = await formPost(
        paths.auth.backupCodesGenerate,
        typedInto(forms[0], { password: WRONG_PASSWORD }),
        session.cookie,
      );
      expect(refused.status).toBe(303);
      expect(refused.headers.get("Location") ?? "").toContain("failed=");
    },
  );

  // plan row 6. A Copy-codes control naming fewer codes than it drew is the drift this catches:
  // each code in its own [data-code] element and one handler reading all ten. The two arms that
  // reveal nothing render neither the control nor a code element (the twin).
  it(
    `§13 · the reveal carries a Copy-codes control that names every code it drew: each code sits in its own [data-code] element and one handler reads all ten · the not-enrolled arm and the enabled arm render no Copy-codes control and no code element (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);
      const card = await (await enable(session.cookie)).text();

      // EVERY code the answer minted sits in its own element. The set the verify form
      // carries forward comes from that same answer, so this is two independent readings of
      // one reveal — a card that chipped nine of ten fails here rather than at a keyboard.
      const carried = (verifyForm(card).codes ?? "").split("\n").map((code) => code.trim());
      expect(carried.length, "the verify form carried no ten codes forward").toBe(10);
      expect(revealedCodesOn(card)).toEqual(carried);

      // ONE handler, and what it reads is the attribute every chip carries — which is what
      // makes "names every code it drew" a fact about the page and not about an ordering.
      const handlers = scriptsOn(card).filter((body) => body.includes("copy-codes"));
      expect(handlers.length, "the reveal drew no single Copy-codes handler").toBe(1);
      expect(handlers[0], "the handler does not read the chips").toContain("[data-code]");
      expect(card, "the reveal drew no Copy-codes control").toContain(`id="copy-codes"`);

      // The twins, as plain GETs of the pane's two arms.
      const notEnrolled = await page(paths.settingsTwoFactor, session.cookie);
      await enrollTwoFactor(ns.owner.userId);
      const enabledArm = await page(paths.settingsTwoFactor, session.cookie);
      for (const [name, html] of [
        ["the not-enrolled arm", notEnrolled],
        ["the enabled arm", enabledArm],
      ] as const) {
        expect(html, `${name} drew a Copy-codes control`).not.toContain("copy-codes");
        expect(revealedCodesOn(html), `${name} drew a code element`).toEqual([]);
      }
    },
  );
  it(
    `§4/§13 · after a complete TOTP sign-in, the minted browser session opens /apps and the same Worker isolate still answers /login — the full password challenge and successful second-factor path, not enrollment verification`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      await seedOwnerCredential(ns.owner.userId);
      const enrollmentSession = await seedOwnerSession(ns.owner);
      const enrollmentCard = await (await enable(enrollmentSession.cookie)).text();
      const enrollmentForm = verifyForm(enrollmentCard);
      const secret = secretOf(enrollmentForm);
      const enrolled = await formPost(
        paths.auth.totpVerifySettings,
        typedInto(enrollmentForm, { code: await totpCode(secret) }),
        enrollmentSession.cookie,
      );
      expect(enrolled.status).toBe(303);

      const password = await formPost(paths.auth.signIn, {
        username: ns.owner.username,
        password: SEEDED_OWNER_PASSWORD,
        callbackURL: paths.apps,
      });
      expect(password.status).toBe(303);
      const challengeUrl = password.headers.get("Location") ?? "";
      expect(challengeUrl).toContain("step=totp");
      const challengeCookie = password.headers
        .getSetCookie()
        .map((header) => header.split(";")[0])
        .join("; ");
      expect(challengeCookie, "password sign-in set no two-factor challenge cookie").not.toBe("");

      const challenge = await anonymousPage(challengeUrl);
      const forms = formsPostingTo(challenge, paths.auth.totpVerify);
      expect(forms.length, "the challenge page rendered no TOTP form").toBeGreaterThan(0);
      const verified = await formPost(
        paths.auth.totpVerify,
        typedInto(forms[0], { code: await totpCode(secret) }),
        challengeCookie,
      );
      expect(verified.status).toBe(303);
      const signedIn = sessionCookieOf(verified);
      expect(signedIn, "successful TOTP verification minted no session cookie").not.toBeNull();
      expect((await get(paths.apps, signedIn ?? "")).status).toBe(200);
      expect((await get(paths.login)).status).toBe(200);
    },
  );

});

/* ------------------------------------------------------------------ *
 * The two Access panes (§13's Tokens and Connected clients)
 * ------------------------------------------------------------------ */

/** §13's three Tokens-pane sentences, byte-for-byte. The footer is ONE string on purpose:
 *  its two sentences are quoted together and a split rendering is the drift these guard. */
// §13's sentence, final again now that the agent page issues keys (2026-09-03, step 9).
const NO_ISSUE_CONTROL = "Issue new keys from an app or agent page.";
const TOKENS_FOOTER =
  "Revoking an app token closes that app's live connection. Keys are shown only once, at issue time.";
const CLIENTS_FOOTER =
  "A client registers itself the first time you approve it on the consent screen — that screen is a step inside the sign-in redirect, never a page you navigate to. Revoking stops its tokens working; the agent it acted as, and that agent's grants, are untouched.";

/** §13 pins the query, so the two narrowed URLs are spelled here — the pane comes from
 *  `paths`, the filter from the spec. */
const TOKENS_AGENTS_ONLY = `${paths.settingsTokens}?kind=agent`;
const TOKENS_APPS_ONLY = `${paths.settingsTokens}?kind=app`;

/** The Tokens pane's read-only world: one tunneled app holding one key, one agent holding
 *  one key. Both slugs are `uniqueSlug`-distinct because the file's own `news` and `agent`
 *  are words the shell renders anyway, and a row asserting "the slug is on the page" would
 *  pass against a page that never drew the column. */
const KEYS_APP = uniqueSlug("keysapp");
const KEYS_AGENT = uniqueSlug("keysagt");

describe(`§13 · the Tokens pane`, () => {
  // G12's interim row (the Tokens intro naming `pmcp token issue`) was retired on
  // 2026-09-03 when the agent page landed: the final sentence is pinned by the pointers row
  // of the /agents describe and by the token_issue row below.

  let keys: { ns: SeededNamespace; session: SeededSession };

  beforeAll(async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: KEYS_APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: KEYS_AGENT, tokens: [{ as: "agt" }] }],
    });
    keys = { ns, session: await seedOwnerSession(ns.owner) };
  });

  /** This describe's own pages, under its OWN session: `page` defaults to the file world's
   *  cookie, a different owner, and asserts 200 — so an omitted cookie would fail as a
   *  login bounce rather than as the property under test. */
  const keysPage = (path: string): Promise<string> => page(path, keys.session.cookie);

  it(`§13 · /settings/tokens lists every key in the namespace, agent and app alike — the set of ids its Revoke/Remove controls name is exactly token_list's unrevoked set, each listed key showing its display prefix, its kind and the slug it is bound to`, async () => {
    const live = (await tokensOf(keys.ns.owner.userId)).filter((row) => row.revokedAt === null);
    // The precondition the claim rests on: this namespace really does hold BOTH kinds, so
    // "agent and app alike" is a fact about the page rather than about the fixture.
    expect(new Set(live.map((row) => row.kind))).toEqual(new Set(["agent", "app"]));

    const html = await keysPage(paths.settingsTokens);
    // A SET both ways, never a count: a responsive pane may legally draw one row as two
    // forms, and §13 pins no control count.
    expect(revokeTargets(html, "token_revoke")).toEqual(new Set(live.map((row) => row.id)));

    // Each row's own window, keyed on its display prefix and closed by the footer — so a
    // page-wide toContain("agent") cannot satisfy the Kind column, and the last row's
    // window does not run on into prose that happens to say "app".
    const blocks = blocksOf(textOf(html), [...live.map((row) => row.prefix), TOKENS_FOOTER]);
    for (const row of live) {
      expect(blocks[row.prefix], `${row.prefix} is not bound to ${row.refSlug}`).toContain(row.refSlug);
      expect(blocks[row.prefix], `${row.prefix} does not say "${row.kind}"`).toMatch(
        new RegExp(`\\b${row.kind}\\b`),
      );
    }
  });

  it(`§13 · a bound-to app slug links to /apps/<slug> · the agent slug beside it links to /agents/<slug> now that the agent page exists (the twin — re-pointed 2026-09-03, step 9)`, async () => {
    const html = await keysPage(paths.settingsTokens);
    expect(html, "the app row does not link its app").toContain(`href="${paths.appDetail(KEYS_APP)}"`);

    // INNER HTML, not text equality: `design/SettingsTokens.dc.html` draws these cells as
    // anchors, and a <span> wrapper inside one would defeat a text check.
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    expect(anchors.length, "the walk found no anchors at all").toBeGreaterThan(0);
    const agentAnchor = anchors.find(
      (anchor) => decodeEntities(attributeOf(anchor[1], "href") ?? "") === paths.agentDetail(KEYS_AGENT),
    );
    expect(agentAnchor, "no anchor links the agent slug to its page").toBeDefined();
    expect(agentAnchor?.[2] ?? "").toContain(KEYS_AGENT);
  });

  it(`§13 · the All · Agents · Apps filter narrows: ?kind=agent lists the namespace's agent keys and no app key, ?kind=app the reverse, and the unfiltered pane lists both (the twin) — each pill followed from the href the pane rendered`, async () => {
    const live = (await tokensOf(keys.ns.owner.userId)).filter((row) => row.revokedAt === null);
    const agentKey = live.find((row) => row.kind === "agent");
    const appKey = live.find((row) => row.kind === "app");
    expect(agentKey, "no agent key seeded").toBeDefined();
    expect(appKey, "no app key seeded").toBeDefined();

    const html = await keysPage(paths.settingsTokens);
    for (const href of [paths.settingsTokens, TOKENS_AGENTS_ONLY, TOKENS_APPS_ONLY]) {
      expect(html, `the pane renders no link to ${href}`).toContain(`href="${href}"`);
    }
    expect(revokeTargets(html, "token_revoke")).toEqual(
      new Set([agentKey?.id ?? "", appKey?.id ?? ""]),
    );

    const agentsOnly = await keysPage(TOKENS_AGENTS_ONLY);
    expect(revokeTargets(agentsOnly, "token_revoke")).toEqual(new Set([agentKey?.id ?? ""]));
    expect(agentsOnly).toContain(agentKey?.prefix ?? "");
    expect(agentsOnly).not.toContain(appKey?.prefix ?? "");

    const appsOnly = await keysPage(TOKENS_APPS_ONLY);
    expect(revokeTargets(appsOnly, "token_revoke")).toEqual(new Set([appKey?.id ?? ""]));
    expect(appsOnly).toContain(appKey?.prefix ?? "");
    expect(appsOnly).not.toContain(agentKey?.prefix ?? "");

    // The filter is provably the PAGE's: `token_list` takes no arguments at all (§8/§13,
    // and contracts pins the schema), so nothing narrowed the read.
    expect(schemaKeysOf(ops.token_list)).toEqual([]);
  });

  it(`§13 · the Tokens rail marker is the number of rows the pane lists, so ?kind=agent narrows the marker with the table · the unfiltered pane's marker counts both keys (the twin)`, async () => {
    const live = (await tokensOf(keys.ns.owner.userId)).filter((row) => row.revokedAt === null);
    const agentKey = live.find((row) => row.kind === "agent");
    expect(agentKey, "no agent key seeded").toBeDefined();
    expect(live.length, "the twin is vacuous unless both kinds are live").toBe(2);

    // §13's rail rule reads the marker off "the number of rows its pane lists", and under
    // `?kind=` the pane lists fewer — so the marker narrows WITH the table rather than
    // reporting holdings the table does not draw. Asserted against `revokeTargets` on the
    // same render, since the claim is that the two cannot disagree.
    const narrowed = await keysPage(TOKENS_AGENTS_ONLY);
    expect(revokeTargets(narrowed, "token_revoke")).toEqual(new Set([agentKey?.id ?? ""]));
    expect(markerOf(narrowed, paths.settingsTokens)).toBe("1");

    // The twin: the same rail entry on the unfiltered pane counts both keys, so "narrows"
    // is not satisfied by a marker that is always the same number.
    expect(markerOf(await keysPage(paths.settingsTokens), paths.settingsTokens)).toBe("2");
  });

  it(`§13 · Revoke on a live row walks end to end as a browser walks it — the form the pane rendered, posted form-encoded to /settings/tokens/token_revoke — and the key is gone from the pane afterwards while token_list still reports its row revoked`, async () => {
    const APP = uniqueSlug("revapp");
    const AGENT = uniqueSlug("revagt");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: AGENT, tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const seeded = await tokensOf(ns.owner.userId);
    const appKey = seeded.find((row) => row.kind === "app");
    const agentKey = seeded.find((row) => row.kind === "agent");
    expect(appKey, "no app key seeded").toBeDefined();

    const html = await page(paths.settingsTokens, session.cookie);
    const control = controlFor(html, appKey?.id ?? "");
    expect(new URL(control.action, ORIGIN).pathname).toBe(`${paths.settingsTokens}/token_revoke`);
    expect(control.label, "a live key's control does not read Revoke").toBe("Revoke");

    // `application/x-www-form-urlencoded`, because the rendered form declares no enctype
    // and that is what a browser sends — NOT the multipart `post()` the older rows use.
    const answered = await formPost(control.action, control.fields, session.cookie);
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(`${paths.settingsTokens}?done=token_revoke`);

    // §13's "revoked rows are not listed" located in the PAGE, with §8's op unchanged.
    const after = await page(paths.settingsTokens, session.cookie);
    expect(revokeTargets(after, "token_revoke").has(appKey?.id ?? "")).toBe(false);
    expect(after).not.toContain(appKey?.prefix ?? "");
    const relisted = await tokensOf(ns.owner.userId);
    // A stamp, not `not.toBeNull()`: `find` yields `undefined` for a row the op DROPPED, and
    // `undefined` is not null — the drift this leg exists to catch would have passed.
    expect(
      relisted.find((row) => row.id === appKey?.id)?.revokedAt,
      "token_list stopped reporting the revoked row",
    ).toEqual(expect.any(Number));
    // Non-vacuous: the other key is still listed, so the pane did not simply empty.
    expect(revokeTargets(after, "token_revoke").has(agentKey?.id ?? "")).toBe(true);
  });

  it(`§13 · an expired key's control reads Remove where a live key's reads Revoke, and both post the same token_revoke target under the pane's own prefix (the twin) — the expired row leaves the listing the same way`, async () => {
    const AGENT = uniqueSlug("expagt");
    const ns = await seedNamespace(env.DB, {
      // The seed's production-path mint against a backdated clock — the only honest
      // already-expired row.
      agents: [{ slug: AGENT, tokens: [{ as: "live" }, { as: "dead", expired: true }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const seeded = await tokensOf(ns.owner.userId);
    const dead = seeded.find((row) => row.expiresAt !== null && row.expiresAt <= Date.now());
    const live = seeded.find((row) => row.id !== dead?.id);
    expect(dead, "no expired key seeded").toBeDefined();
    expect(live, "no live key seeded").toBeDefined();

    const html = await page(paths.settingsTokens, session.cookie);
    const removeControl = controlFor(html, dead?.id ?? "");
    const revokeControl = controlFor(html, live?.id ?? "");
    expect(removeControl.label).toBe("Remove");
    expect(revokeControl.label).toBe("Revoke");
    // "Both `token_revoke`", read off the page rather than assumed: same pathname under the
    // pane's own prefix, and the only thing that differs is the id.
    const removeUrl = new URL(removeControl.action, ORIGIN);
    const revokeUrl = new URL(revokeControl.action, ORIGIN);
    expect(removeUrl.pathname).toBe(`${paths.settingsTokens}/token_revoke`);
    expect(revokeUrl.pathname).toBe(removeUrl.pathname);
    // Spelling-blind, like `controlFor` itself: whether the id rides the query or a hidden
    // control is the direction-B row's business, so only WHICH id each names is pinned.
    expect(removeUrl.searchParams.get("id") ?? removeControl.fields.id).toBe(dead?.id);
    expect(revokeUrl.searchParams.get("id") ?? revokeControl.fields.id).toBe(live?.id);

    const answered = await formPost(removeControl.action, removeControl.fields, session.cookie);
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(`${paths.settingsTokens}?done=token_revoke`);

    // Remove is the same mutation and not a no-op — and the live twin is still there.
    const after = await page(paths.settingsTokens, session.cookie);
    expect(revokeTargets(after, "token_revoke").has(dead?.id ?? "")).toBe(false);
    expect(revokeTargets(after, "token_revoke").has(live?.id ?? "")).toBe(true);
  });

  it(`§13 · the Tokens pane renders no token_issue control — "Issue new keys from an app or agent page." and its two-sentence footer render verbatim instead · the same pane does render token_revoke forms, so this is an absent control and not an absent pane (the twin)`, async () => {
    const html = await keysPage(paths.settingsTokens);
    // A control of ANY shape: §13's "No Issue control" is not only about forms.
    const fronted = formsRenderedOn(html).map((form) => form.op);
    expect(fronted, "the pane fronts token_issue").not.toContain("token_issue");
    const anchors = [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)];
    expect(anchors.length, "the walk found no anchors at all").toBeGreaterThan(0);
    for (const anchor of anchors) {
      const href = new URL(decodeEntities(anchor[1]), ORIGIN);
      expect(href.pathname.split("/").filter(Boolean).pop() ?? "").not.toBe("token_issue");
    }
    // The twin: an absent control, not an absent pane.
    expect(fronted.filter((op) => op === "token_revoke").length).toBeGreaterThan(0);

    // The prose decoder, which handles the `&#39;` in "that app's" — NOT `decodeEntities`,
    // which documents itself as the URL-attribute decoder.
    const text = textOf(html);
    expect(text).toContain(NO_ISSUE_CONTROL);
    expect(text).toContain(TOKENS_FOOTER);
  });

  it(`§13 · the two Access panes draw the column names §13 spells — Token / Kind / Bound to / Created / Expires / Last used under an All · Agents · Apps filter, and Client / Acts as / Created / Last used / Status — the same class of durable string the Sessions pane's three already pin`, async () => {
    // The client's name is generated and contains neither `Client` nor `Status`: a row
    // VALUE spelling a header would satisfy that header's assertion and prove nothing.
    const AGENT = uniqueSlug("colagt");
    const APP = uniqueSlug("colapp");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: AGENT, tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    await consentOnce(ns, session.cookie, AGENT, { client_name: uniqueSlug("colcli") });

    // Asserted FIRST through the ops, so no header is checked against an empty state.
    expect((await tokensOf(ns.owner.userId)).length).toBeGreaterThan(0);
    expect((await connectionsOf(ns.owner.userId)).length).toBeGreaterThan(0);

    // Word boundaries throughout, so a longer word cannot satisfy a header: the rail's own
    // entry reads `Tokens`, and both `Client` and `current` are already true of every
    // settings page.
    const tokensText = textOf(await page(paths.settingsTokens, session.cookie));
    for (const header of [/\bToken\b/, /\bKind\b/, /\bCreated\b/, /\bExpires\b/]) {
      expect(tokensText, `the Tokens pane draws no ${header.source}`).toMatch(header);
    }
    expect(tokensText).toContain("Bound to");
    expect(tokensText).toContain("Last used");

    // The filter's three labels read as the ANCHORS' own text: the shell's top nav already
    // renders the word `Apps`, and the rail's Tokens entry shares the unfiltered href.
    const tokensHtml = await page(paths.settingsTokens, session.cookie);
    expect(linkTexts(tokensHtml, paths.settingsTokens)).toContain("All");
    expect(linkTexts(tokensHtml, TOKENS_AGENTS_ONLY)).toContain("Agents");
    expect(linkTexts(tokensHtml, TOKENS_APPS_ONLY)).toContain("Apps");

    const clientsText = textOf(await page(paths.settingsClients, session.cookie));
    for (const header of [/\bClient\b/, /\bCreated\b/, /\bStatus\b/]) {
      expect(clientsText, `the clients pane draws no ${header.source}`).toMatch(header);
    }
    expect(clientsText).toContain("Acts as");
    expect(clientsText).toContain("Last used");
  });
});

describe(`§13/§19 · the Connected clients pane`, () => {
  it(`§13/§19 · GET /oauth/connections answers 301 to /settings/clients, and the pane it points at lists the binding — the redirect's code and target are pinned, not merely "a redirect"`, async () => {
    await consentOnce(world.ns, world.session.cookie, "agent", { client_name: "Listed Client" });

    // 301 exactly — §13 pins the CODE, because the move is permanent and a 302 would leave
    // every bookmark coming back here forever.
    const redirected = await get(paths.oauthConnections);
    expect(redirected.status).toBe(301);
    expect(redirected.headers.get("Location")).toBe(paths.settingsClients);
    // Nothing is asserted about the anonymous case: /oauth/connections is not under
    // /settings/* and §13 pins no gate for it.
    expect(await page(paths.settingsClients)).toContain("Listed Client");
  });

  it(`§13/§19 · the connections POST moved with its pane: nothing routes /oauth/connections/connection_revoke any more — it reaches connection_revoke zero times, and no rendered page posts under the old path · the same revoke at /settings/clients/connection_revoke reaches it exactly once and lands back on the pane (the twin)`, async () => {
    const AGENT = uniqueSlug("movagt");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const { bindingId } = await consentOnce(ns, session.cookie, AGENT, {
      client_name: uniqueSlug("movcli"),
    });

    // The CSRF token comes off the dialog, which is where §13 puts this pane's Revoke —
    // the bare pane renders no form of its own, and the shell's Sign out carries none.
    const listed = await page(paths.settingsClients, session.cookie);
    const dialog = await page(confirmLinkFor(listed, "revoke-connection", bindingId) ?? "", session.cookie);
    const csrf = csrfOf(dialog);

    await withCountedOps(["connection_revoke"], async (invocations) => {
      // Spelled literally on purpose: this is the string that must no longer route, so it
      // cannot come from `paths`.
      const gone = await post(
        `/oauth/connections/connection_revoke?id=${bindingId}`,
        {},
        { cookie: session.cookie, csrf },
      );
      expect(times(invocations, "connection_revoke")).toBe(0);
      // Observed 404: the `oauth` mount's own `claim(...)` tail answers anything under
      // /oauth/ that no route took. Recorded rather than asserted as a §13 claim — what
      // §13 pins is that the op is not reached and nothing is written.
      expect(gone.status).toBeGreaterThanOrEqual(400);
      expect(gone.headers.get("Location")).toBeNull();

      const answered = await post(paths.connectionRevoke(bindingId), {}, { cookie: session.cookie, csrf });
      expect(answered.status, await answered.text()).toBe(303);
      expect(new URL(answered.headers.get("Location") ?? "", ORIGIN).pathname).toBe(paths.settingsClients);
      expect(times(invocations, "connection_revoke")).toBe(1);
    });

    // The totality half §13 actually pins: nothing the seven panes render points under the
    // old prefix, as a form action or as a link.
    for (const pane of PANES) {
      const html = await paneWithDialogs(pane, session.cookie);
      const rendered = [
        ...postTargets(html),
        ...[...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((anchor) => decodeEntities(anchor[1])),
      ];
      // The negative's own precondition: a pane that rendered nothing at all would pass
      // the loop below without ever entering it.
      expect(rendered.length, `${pane} rendered no targets at all`).toBeGreaterThan(0);
      for (const target of rendered) {
        expect(target.startsWith(`${paths.oauthConnections}/`), `${pane} points at ${target}`).toBe(false);
      }
    }
  });

  it(`§13/§19.5 · a connected client's row shows the name it registered with, the ORIGIN of its registered redirect URI beneath it — never the full URI — and the bound agent's slug linking to /agents/<slug> under Acts as (re-pointed 2026-09-03, step 9) · a client that registered without a name shows its client id in the name's place (the twin)`, async () => {
    const AGENT = uniqueSlug("acts");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const named = `Named ${uniqueSlug("named")}`;
    await consentOnce(ns, session.cookie, AGENT, {
      client_name: named,
      redirect_uris: [REDIRECT_A],
    });
    // GENUINELY absent, not `""`: `listConnections` coalesces with `??`, so an empty string
    // would survive as `""` and pin a render §13 never describes.
    const { clientId: nameless } = await consentOnce(ns, session.cookie, AGENT, {
      client_name: undefined,
      redirect_uris: [REDIRECT_B],
    });

    const rows = await connectionsOf(ns.owner.userId);
    expect(rows.find((row) => row.clientId === nameless)?.clientName).toBeNull();

    const html = await page(paths.settingsClients, session.cookie);
    expect(html, "the named client's name is missing").toContain(named);
    // The origin is a strict prefix of the URI, so only the ABSENCE carries the claim.
    expect(html).toContain(new URL(REDIRECT_A).origin);
    expect(html, "the pane renders the whole redirect URI").not.toContain(REDIRECT_A);
    expect(html, "the nameless client shows no id").toContain(nameless);

    expect(textOf(html)).toContain(AGENT);
    // Acts as LINKS to the agent page now that it exists (2026-09-03, step 9).
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    const actsAs = anchors.find(
      (anchor) => decodeEntities(attributeOf(anchor[1], "href") ?? "") === paths.agentDetail(AGENT),
    );
    expect(actsAs, "no anchor links the agent slug to its page").toBeDefined();
    expect(actsAs?.[2] ?? "").toContain(AGENT);
  });

  it(`§13/§19.5 · a self-registered (DCR) client's row carries the "unverified" marker · a client registered under the owner's own session does not (the twin) — the consent screen's second identity string, repeated on the pane`, async () => {
    // TWO namespaces, each holding exactly ONE connection — which is what makes the twin
    // markup-free: the page-wide assertion IS the row-level one. Never `world.ns`, where a
    // dozen earlier §19 rows have already bound DCR clients.
    const dcr = await oneConnectedNamespace(uniqueSlug("dcr"));
    const known = await oneConnectedNamespace(uniqueSlug("known"), true);

    const selfRegistered = await page(paths.settingsClients, dcr.session.cookie);
    const preRegistered = await page(paths.settingsClients, known.session.cookie);
    // Each page holds ONE row, so its client's name being there is what makes the absence
    // below about the marker rather than about an empty pane.
    expect(selfRegistered).toContain(dcr.client);
    expect(preRegistered).toContain(known.client);
    expect(selfRegistered).toContain("unverified");
    expect(preRegistered).not.toContain("unverified");
  });

  it(`§13 · the Connected clients footer renders verbatim, as one block — a client registers itself at the consent screen, and revoking touches neither the agent it acted as nor that agent's grants`, async () => {
    // The prose decoder, which turns the `&#39;` in "agent's" back into an apostrophe —
    // not the shared URL-attribute `decodeEntities`. ONE string exactly as §13 quotes it,
    // em dash and semicolon included: a split rendering is the drift this guards.
    expect(textOf(await page(paths.settingsClients))).toContain(CLIENTS_FOOTER);
  });

  it(`§13/§19.6 · Revoke walks end to end from an active row as a browser walks it — the confirm link on /settings/clients, the dialog whose own form names that row, the form-encoded POST to /settings/clients/connection_revoke, the 303 back to the pane — and the row STAYS listed afterwards as revoked with no control of any shape · it rendered one while it was active (the twin)`, async () => {
    const AGENT = uniqueSlug("revcagt");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const client = uniqueSlug("revcli");
    const { bindingId } = await consentOnce(ns, session.cookie, AGENT, { client_name: client });

    const listed = await page(paths.settingsClients, session.cookie);
    // The twin, asserted BEFORE the post: while it was active, the pane rendered a control.
    const confirm = confirmLinkFor(listed, "revoke-connection", bindingId);
    expect(confirm, "the active row rendered no confirm link").not.toBeNull();
    // §13's "confirm state rides the owning pane's URL", made observable.
    expect(new URL(confirm ?? "", ORIGIN).pathname).toBe(paths.settingsClients);

    // The dialog's OWN form names this row — §13 pins no dialog copy for this pane and
    // `design/Dialogs.dc.html` draws no connection dialog, so the copy is not asserted.
    const dialog = await page(confirm ?? "", session.cookie);
    const control = controlFor(dialog, bindingId);
    expect(new URL(control.action, ORIGIN).pathname).toBe(`${paths.settingsClients}/connection_revoke`);
    // The move's other half, on the two renders this row already holds: the pane and its
    // dialog post at the new prefix and nothing posts at the old one (§19).
    for (const target of postTargets([listed, dialog].join("\n"))) {
      expect(target.startsWith(`${paths.oauthConnections}/`), `posts at ${target}`).toBe(false);
    }

    const answered = await formPost(control.action, control.fields, session.cookie);
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(`${paths.settingsClients}?done=connection_revoke`);

    // A revoked row STAYS listed, because re-consent revives it (§19.4's UNIQUE pair) —
    // with no control of any shape, the same both-shapes check the No-Issue row makes.
    const after = await page(paths.settingsClients, session.cookie);
    expect(after, "the revoked client left the listing").toContain(client);
    expect(textOf(after)).toMatch(/\brevoked\b/);
    expect(textOf(after)).not.toMatch(/\bactive\b/);
    expect(revokeTargets(await paneWithDialogs(paths.settingsClients, session.cookie), "connection_revoke")).toEqual(
      new Set(),
    );
    expect(confirmLinkFor(after, "revoke-connection", bindingId)).toBeNull();
  });

  it(`§13 · a POST to either ops-backed Settings pane carrying no CSRF field is 403 and nothing is revoked · the same target carrying the token that pane rendered succeeds (the twin) — one gate over the /settings prefix, proven on both dispatches`, async () => {
    const AGENT = uniqueSlug("csrfagt");
    const APP = uniqueSlug("csrfapp");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: AGENT }],
    });
    const session = await seedOwnerSession(ns.owner);
    const { clientId, bindingId } = await consentOnce(ns, session.cookie, AGENT, {
      client_name: uniqueSlug("csrfcli"),
    });
    const tokenId = (await tokensOf(ns.owner.userId))[0].id;

    // Each leg carries the read of ITS OWN row, because the twin below revokes as it goes:
    // a shared postcondition would be false of the first leg's row by the second's turn.
    const legs = [
      {
        pane: paths.settingsTokens,
        id: tokenId,
        revokedAt: async (): Promise<number | null> =>
          (await tokensOf(ns.owner.userId)).find((row) => row.id === tokenId)?.revokedAt ?? null,
      },
      {
        pane: paths.settingsClients,
        id: bindingId,
        revokedAt: async (): Promise<number | null> =>
          (await bindingFor(ns.owner.userId, clientId))?.revokedAt ?? null,
      },
    ];
    let walked = 0;
    for (const leg of legs) {
      // Read off the page, never spelled — and through the pane's WHOLE control surface,
      // since the clients pane's Revoke lives in its dialog.
      const html = await paneWithDialogs(leg.pane, session.cookie);
      const target = controlFor(html, leg.id).action;

      // No `csrf` field at all — the shape of a cross-site post.
      const refused = await post(target, {}, { cookie: session.cookie });
      expect(refused.status, `POST ${target} with no CSRF field`).toBe(403);
      // The refusal did not answer 403 AFTER mutating.
      expect(await leg.revokedAt(), `the refused POST ${target} revoked its row`).toBeNull();

      const accepted = await post(target, {}, { cookie: session.cookie, csrf: csrfOf(html) });
      expect(accepted.status, `POST ${target} with the page's own token`).toBe(303);
      expect(await leg.revokedAt(), `the accepted POST ${target} revoked nothing`).not.toBeNull();
      walked += 1;
    }
    // Two route groups, not one: "they share a handler" is an assumption about code.
    expect(walked, "the walk did not cover both dispatchers").toBe(2);
  });

  it(`§19.4/§13 · consenting again after a revoke revives the same row — /settings/clients holds exactly one row for that client, active and revocable again, and oauth_binding still holds exactly one row for the pair`, async () => {
    const AGENT = uniqueSlug("reagt");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const client = uniqueSlug("recli");
    const { clientId, bindingId } = await consentOnce(ns, session.cookie, AGENT, { client_name: client });
    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);

    const listed = await page(paths.settingsClients, session.cookie);
    const dialog = await page(confirmLinkFor(listed, "revoke-connection", bindingId) ?? "", session.cookie);
    const control = controlFor(dialog, bindingId);
    expect((await formPost(control.action, control.fields, session.cookie)).status).toBe(303);
    // The pair survives the revoke: an implementation that DELETED the row instead of
    // marking it revoked reads 0 here, and §19.4's UNIQUE (owner_id, client_id) is the
    // whole reason re-consent revives rather than duplicates.
    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);

    // The revoked state BETWEEN the two consents is what makes "revives" non-vacuous.
    const revoked = await page(paths.settingsClients, session.cookie);
    expect(textOf(revoked)).toMatch(/\brevoked\b/);
    expect(revokeTargets(await paneWithDialogs(paths.settingsClients, session.cookie), "connection_revoke")).toEqual(
      new Set(),
    );

    await consentAgain(ns, session.cookie, AGENT, clientId);

    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);
    const revived = await page(paths.settingsClients, session.cookie);
    // Occurrence count, which is why the name is generated per case.
    expect(mentions(textOf(revived), client)).toBe(1);
    expect(textOf(revived)).toMatch(/\bactive\b/);
    expect(textOf(revived)).not.toMatch(/\brevoked\b/);
    expect(
      revokeTargets(await paneWithDialogs(paths.settingsClients, session.cookie), "connection_revoke"),
    ).toEqual(new Set([bindingId]));
  });

  it(`§8 · the Tokens and Connected clients panes DO front ops, and each form's field set equals schemaKeysOf(ops[name]) — the two Access panes join parity direction B rather than the parity exception (the twin of the four panes that front none)`, async () => {
    const AGENT = uniqueSlug("dirbagt");
    const APP = uniqueSlug("dirbapp");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: AGENT, tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    await consentOnce(ns, session.cookie, AGENT, { client_name: uniqueSlug("dirbcli") });

    const seen = new Set<string>();
    let checked = 0;
    for (const pane of [paths.settingsTokens, paths.settingsClients]) {
      // The dialog renders are required for the clients pane, whose Revoke §13 puts behind
      // a confirm dialog; the Tokens pane's Revoke/Remove, which §13 does not gate, are
      // found inline in the bare render the same walk collects.
      for (const form of formsRenderedOn(await paneWithDialogs(pane, session.cookie))) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) continue;
        expect(Object.prototype.hasOwnProperty.call(ops, form.op), `${pane} fronts "${form.op}"`).toBe(true);
        expect(form.fields, `${pane}'s ${form.op} form`).toEqual(schemaKeysOf(ops[form.op]));
        seen.add(form.op);
        checked += 1;
      }
    }
    expect(checked, "no form on either Access pane was checked").toBeGreaterThan(0);
    expect([...seen].sort()).toEqual(["connection_revoke", "token_revoke"]);
  });

  it(`§13 · the two Access markers part company on a revoked row by design: the Tokens marker counts the rows its pane lists — the live key and the expired one, never the revoked one — while the Connected clients marker counts ITS pane's rows with a revoked client among them · revoking through each pane's own control then moves the Tokens marker by one and the clients marker by none (the twin)`, async () => {
    // The complement of the rail-count row, which seeds four LIVE keys and no revoked or
    // expired one — leaving both markers satisfiable by a query the shell rule forbids.
    const KEYS = uniqueSlug("markkeys");
    const AGENT = uniqueSlug("markagt");
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: KEYS,
          kind: "tunnel",
          // Both production paths: `revokeToken` for the dead one, a backdated clock for
          // the expired one.
          tokens: [{ as: "live" }, { as: "stale", expired: true }, { as: "dead", revoked: true }],
        },
      ],
      agents: [{ slug: AGENT }],
    });
    const session = await seedOwnerSession(ns.owner);
    const clientA = uniqueSlug("markcla");
    const clientB = uniqueSlug("markclb");
    const bindingA = await consentOnce(ns, session.cookie, AGENT, { client_name: clientA });
    const bindingB = await consentOnce(ns, session.cookie, AGENT, { client_name: clientB });
    // A is revoked through the OP, leaving the pane's own control unspent for the delta.
    await ops.connection_revoke.handler(ns.owner.userId, { id: bindingA.bindingId });

    // Preconditions through the ops, told apart by `expiresAt`/`revokedAt` rather than by
    // the seed's handles.
    const seeded = (await tokensOf(ns.owner.userId)).filter((row) => row.refSlug === KEYS);
    const dead = seeded.filter((row) => row.revokedAt !== null);
    const stale = seeded.filter(
      (row) => row.revokedAt === null && row.expiresAt !== null && row.expiresAt <= Date.now(),
    );
    const live = seeded.filter(
      (row) => row.revokedAt === null && (row.expiresAt === null || row.expiresAt > Date.now()),
    );
    expect([seeded.length, live.length, stale.length, dead.length]).toEqual([3, 1, 1, 1]);
    const connections = await connectionsOf(ns.owner.userId);
    expect(connections.length).toBe(2);
    expect(connections.filter((row) => row.revokedAt !== null).length).toBe(1);

    // TOKENS: "3" is the token_list().length bug and "1" the live-keys-only bug. No single
    // implementation satisfies both this row and the rail-count row's "4".
    const tokensHtml = await page(paths.settingsTokens, session.cookie);
    expect(markerOf(tokensHtml, paths.settingsTokens)).toBe("2");
    expect(revokeTargets(tokensHtml, "token_revoke").size).toBe(2);
    expect(tokensHtml).toContain(live[0].prefix);
    expect(tokensHtml).toContain(stale[0].prefix);
    expect(tokensHtml, "the revoked key is still listed").not.toContain(dead[0].prefix);

    // CLIENTS: "2" with a revoked row among them, and only B is revocable — the leg a
    // live-bindings-only "1" fails.
    const clientsHtml = await page(paths.settingsClients, session.cookie);
    expect(markerOf(clientsHtml, paths.settingsClients)).toBe("2");
    expect([clientA, clientB].filter((name) => clientsHtml.includes(name)).length).toBe(2);
    const revocable = revokeTargets(
      await paneWithDialogs(paths.settingsClients, session.cookie),
      "connection_revoke",
    );
    expect(revocable).toEqual(new Set([bindingB.bindingId]));

    // THE DELTA, each posted as the browser posts it.
    const revoke = controlFor(tokensHtml, live[0].id);
    expect((await formPost(revoke.action, revoke.fields, session.cookie)).status).toBe(303);
    const tokensAfter = await page(paths.settingsTokens, session.cookie);
    // A drop to "0" would mean the post revoked more than the control named.
    expect(markerOf(tokensAfter, paths.settingsTokens)).toBe("1");
    expect(tokensAfter).toContain(stale[0].prefix);

    const dialog = await page(
      confirmLinkFor(clientsHtml, "revoke-connection", bindingB.bindingId) ?? "",
      session.cookie,
    );
    const control = controlFor(dialog, bindingB.bindingId);
    expect((await formPost(control.action, control.fields, session.cookie)).status).toBe(303);
    const clientsAfter = await page(paths.settingsClients, session.cookie);
    expect(markerOf(clientsAfter, paths.settingsClients)).toBe("2");
    expect(clientsAfter).toContain(clientB);
  });
});

describe(`§23 · /settings/execution — the timeout pair`, () => {
  /** The pane's two controls as the render drew them, by field name — read off the form
   *  itself, so a pane that drew constants where the op's read belongs cannot pass. */
  const pairOn = (html: string): Record<string, string> => {
    const [drawn] = formsPostingTo(html, paths.settingsExecutionUpdate);
    return { defaults: drawn?.default_timeout_ms ?? "", maximum: drawn?.max_timeout_ms ?? "" };
  };

  it(`§23 · the pane renders hub_settings_get's committed pair as two integer millisecond controls over one Save, bounded by the op's own minimum and ceiling, and the rail marker reads the pair in seconds`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // A pair that is NOT the pinned default, so a pane drawing constants cannot pass.
    await ops.hub_settings_update.handler(ns.owner.userId, { default_timeout_ms: 45_000, max_timeout_ms: 120_000 });

    const html = await page(paths.settingsExecution, session.cookie);
    expect(pairOn(html)).toEqual({ defaults: "45000", maximum: "120000" });
    // The bounds the op's schema advertises, on the controls a browser validates with.
    expect(html).toContain(`min="${HUB_MIN_TIMEOUT_MS}"`);
    expect(html).toContain(`max="${HUB_HARD_MAX_TIMEOUT_MS}"`);
    expect(csrfOf(html)).not.toBe("");
    expect(markerOf(html, paths.settingsExecution)).toBe("45s / 120s");
  });

  it(`§23 · a valid Save writes the pair, redirects to the pane with the notice, and the pane at that Location reads the committed pair back — with exactly one admin.hub_settings_update row`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const rendered = await page(paths.settingsExecution, session.cookie);
    const [drawn] = formsPostingTo(rendered, paths.settingsExecutionUpdate);

    const answered = await formPost(
      paths.settingsExecutionUpdate,
      typedInto(drawn ?? {}, { default_timeout_ms: "60000", max_timeout_ms: "150000" }),
      session.cookie,
    );
    expect(answered.status).toBe(303);
    const back = new URL(answered.headers.get("Location") ?? "", ORIGIN);
    expect(back.pathname).toBe(paths.settingsExecution);
    expect(back.searchParams.get("done")).toBe("hub_settings_update");
    expect((await query(env.DB, ns.owner.userId, { event: "admin.hub_settings_update" })).total).toBe(1);
    const stored = (await ops.hub_settings_get.handler(ns.owner.userId, {})) as {
      settings: { defaultTimeoutMs: number; maxTimeoutMs: number };
    };
    expect(stored.settings).toEqual({ defaultTimeoutMs: 60_000, maxTimeoutMs: 150_000 });
    expect(pairOn(await page(`${back.pathname}${back.search}`, session.cookie))).toEqual({
      defaults: "60000",
      maximum: "150000",
    });
  });

  it(`§23 · an invalid pair redraws the pane at 400 with the op's sentence under the control it named and the owner's own text in both boxes, and writes nothing — the ordering rule, the floor, and a non-integer each land on their own field (the twins)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const rendered = await page(paths.settingsExecution, session.cookie);
    const [drawn] = formsPostingTo(rendered, paths.settingsExecutionUpdate);
    const before = (await query(env.DB, ns.owner.userId, {})).total;

    for (const [typed, sentence] of [
      [{ default_timeout_ms: "200000", max_timeout_ms: "100000" }, 'Must not exceed "max_timeout_ms".'],
      [{ default_timeout_ms: "500", max_timeout_ms: "30000" }, "Is below the minimum this tool accepts."],
      [{ default_timeout_ms: "soon", max_timeout_ms: "30000" }, "Has the wrong type."],
    ] as const) {
      const refused = await formPost(
        paths.settingsExecutionUpdate,
        typedInto(drawn ?? {}, { ...typed }),
        session.cookie,
      );
      expect(refused.status, typed.default_timeout_ms).toBe(400);
      const html = await refused.text();
      expect(textOf(html), typed.default_timeout_ms).toContain(sentence);
      expect(pairOn(html).defaults, "the owner's own text was not redrawn").toBe(typed.default_timeout_ms);
    }
    expect((await query(env.DB, ns.owner.userId, {})).total, "a refused pair wrote").toBe(before);
  });
});

/** Two-label hosts on purpose (constraint 24): a three-label one matches the three-segment
 *  JWT shape this file's hygiene guards look for, turning a guard into a false red. */
const REDIRECT_A = "https://named.example/callback";
const REDIRECT_B = "https://other.example/callback";

/** One namespace holding exactly ONE connection, so a page-wide assertion about its row IS
 *  a row-level one. `preRegistered` decides the only difference the unverified twin turns
 *  on: whether the owner's session was on the registration (`oauthClient.userId` written)
 *  or the client registered itself (§19.3's DCR). */
async function oneConnectedNamespace(
  name: string,
  preRegistered = false,
): Promise<{ ns: SeededNamespace; session: SeededSession; client: string }> {
  const agent = uniqueSlug(`${name}agt`);
  const client = `${name} client`;
  const ns = await seedNamespace(env.DB, { agents: [{ slug: agent }] });
  const session = await seedOwnerSession(ns.owner);
  await consentOnce(
    ns,
    session.cookie,
    agent,
    { client_name: client },
    preRegistered ? session.cookie : undefined,
  );
  // The fixture asserts its own defining property, because the rows that use it argue from
  // it: a page-wide assertion is a row-level one only while the page holds ONE row.
  expect((await connectionsOf(ns.owner.userId)).length, "the namespace holds more than one connection").toBe(1);
  return { ns, session, client };
}

/** A SECOND consent for a client that already has a binding — `consentOnce` registers a
 *  fresh client every time, and §19.4's revival is about the same one coming back. */
async function consentAgain(
  ns: SeededNamespace,
  cookie: string,
  agentSlug: string,
  clientId: string,
): Promise<void> {
  const { html, oauthQuery } = await reachConsent(clientId, cookie, {
    resource: oauthResourceFor(ns.owner.username),
  });
  const accepted = await post(
    paths.oauthConsent,
    { oauth_query: oauthQuery, decision: "accept", agent: agentSlug },
    { cookie, csrf: csrfOf(html) },
  );
  expect(accepted.status, await accepted.text()).toBe(303);
}

/** The seven rail entries' URLs, in the brief's table order — built from `paths`, never
 *  spelled, so a pane added to `APP_PANES` is walked with no edit here. */
function appRailHrefs(slug: string): string[] {
  return APP_PANES.map((pane) => paths.appPane(slug, pane));
}

/** Those, plus the landing: every URL one app's page answers at. */
function appPaneHrefs(slug: string): string[] {
  return [paths.appDetail(slug), ...appRailHrefs(slug)];
}

let detail: {
  ns: SeededNamespace;
  session: SeededSession;
  /** One owner bearer for every app-detail describe — `user:<name>`, the principal §7
   *  step 2 leaves unfiltered on the scoped endpoint. */
  bearer: string;
};

async function registerOAuthClient(
  fields: Record<string, unknown> = {},
  cookie?: string,
): Promise<{ clientId: string }> {
  const response = await call(
    new Request(`${OAUTH2}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // A cookie-bearing write needs the hub's own Origin, exactly like every other
        // cookie-carrying call this file makes through identity's door (crossOrigin's rule).
        ...(cookie === undefined ? {} : { cookie, origin: ORIGIN }),
      },
      body: JSON.stringify({
        client_name: "Test Connector",
        redirect_uris: [OAUTH_REDIRECT_URI],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        ...fields,
      }),
    }),
  );
  const body = (await response.json().catch(() => ({}))) as { client_id?: string };
  if (typeof body.client_id !== "string") throw new Error(`registerOAuthClient: ${response.status}`);
  return { clientId: body.client_id };
}

/** `/api/auth/oauth2/authorize` for one client, PKCE included — the query every case in
 *  this section starts from, `extra` widening it (a `resource` naming the namespace). */
function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT_URI,
    response_type: "code",
    scope: "mcp",
    code_challenge: PKCE_CHALLENGE,
    code_challenge_method: "S256",
    ...extra,
  });
  return `${OAUTH2}/authorize?${params}`;
}

/** §19.3's one spelling of a namespace's OAuth resource identifier — the same string
 *  admin.provisionUser writes and the PRM names, built here rather than imported (a test
 *  fixture's own business, not a module this file otherwise depends on). */
function oauthResourceFor(username: string): string {
  return `${ORIGIN}/${username}/mcp`;
}

/**
 * Drives GET `/api/auth/oauth2/authorize` with a session cookie all the way to the hub's
 * own `/oauth/consent` (§19.5 step 2) and returns its rendered HTML alongside the RAW signed
 * query the redirect carried — the same bytes the hidden field must echo (case 8).
 */
async function reachConsent(
  clientId: string,
  cookie: string,
  extra: Record<string, string> = {},
): Promise<{ html: string; oauthQuery: string }> {
  const authorized = await call(new Request(authorizeUrl(clientId, extra), { headers: { Cookie: cookie } }));
  expect(authorized.status, "authorize did not redirect to consent").toBe(302);
  const location = authorized.headers.get("Location") ?? "";
  expect(location, `authorize did not land on /oauth/consent: ${location}`).toMatch(/^\/oauth\/consent\?/);
  const oauthQuery = location.split("?")[1] ?? "";
  const response = await call(new Request(`${ORIGIN}${location}`, { headers: { Cookie: cookie } }));
  const html = await response.text();
  expect(response.status, html).toBe(200);
  return { html, oauthQuery };
}

/** One `oauth_binding` row, read straight off D1 — the ground truth the consent POST and
 *  Revoke are checked against, exactly like `stateRows`/`connectionOf` read theirs. */
async function bindingFor(
  ownerId: string,
  clientId: string,
): Promise<{ id: string; agentId: string; revokedAt: number | null } | null> {
  const row = await (env.DB as D1Like)
    .prepare(
      `SELECT "id", "agent_id", "revoked_at" FROM oauth_binding WHERE "owner_id" = ? AND "client_id" = ?`,
    )
    .bind(ownerId, clientId)
    .first<{ id: string; agent_id: string; revoked_at: number | null }>();
  return row === null ? null : { id: row.id, agentId: row.agent_id, revokedAt: row.revoked_at ?? null };
}

/** How many `oauth_binding` rows one (owner, client) pair has — "never a second row". */
async function countBindings(ownerId: string, clientId: string): Promise<number> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT COUNT(*) AS n FROM oauth_binding WHERE "owner_id" = ? AND "client_id" = ?`)
    .bind(ownerId, clientId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Whether the provider's own consent row still exists — Revoke deletes it so a refresh
 *  cannot resurrect a revoked connection (§19.6). */
async function consentRowExists(ownerId: string, clientId: string): Promise<boolean> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT 1 AS ok FROM "oauthConsent" WHERE "clientId" = ? AND "userId" = ?`)
    .bind(clientId, ownerId)
    .first<{ ok: number }>();
  return row !== null;
}

/** The rendered `<button name="decision" value="…">` element itself, so a case can check
 *  whether IT (not the form, not the page) carries `disabled`. */
function submitButtonHtml(html: string, value: string): string {
  const match = new RegExp(`<button[^>]*name="decision"[^>]*value="${value}"[^>]*>`).exec(html);
  if (match === null) throw new Error(`the page rendered no submit button valued "${value}"`);
  return match[0];
}

/* ------------------------------------------------------------------ *
 * Reading the pages back
 * ------------------------------------------------------------------ */

/**
 * The better-auth endpoints the credential forms post to, as their final path segment —
 * read off `paths.auth` rather than spelled, so a remount moves both sides together. Every
 * member EXCEPT `base` is a target: most are now hub-owned translation routes rather than
 * better-auth's own mount (better-auth's router allows `application/json` only, so a
 * server-rendered form cannot post to one), and each keeps the final segment of the
 * endpoint it fronts — which is what makes the final segment still name the endpoint.
 */
const BETTER_AUTH_ACTIONS: ReadonlySet<string> = new Set(
  Object.values<string>(paths.auth)
    .filter((path) => path !== paths.auth.base)
    .map((path) => path.split("/").pop() ?? ""),
);

/**
 * Every credential mutation /settings fronts, DERIVED from `paths.auth` rather than listed:
 * a translation target under the /settings prefix is one of §4's credential-management
 * endpoints, and a sixth added there is walked by case 26 without this or the case being
 * edited. The /login targets are not here and must not be — they have no session to gate
 * with, which is the whole reason they stand outside `mutation`.
 */
const SETTINGS_CREDENTIAL_TARGETS: readonly string[] = Object.values<string>(paths.auth).filter(
  (path) => path.startsWith(`${paths.settings}/`),
);

const BROWSER_ONLY_TARGETS: ReadonlySet<string> = new Set([
  "connect",
  "push",
  "decide",
  ...BETTER_AUTH_ACTIONS,
]);

/**
 * Every SERVER-RENDERED, session-backed page — the walk's input for case 4.
 *
 * `/apps`, `/apps/new` and the app page's eight URLs left this list with the SPA cutover
 * (2026-09-18), and `/audit` with decision 36: they answer a shell document that renders no
 * form at all, so walking them would only ever prove the shell carries none. The coverage
 * that went with them — the one
 * retained `/apps/connect` form's CSRF field, now drawn client-side where no server-HTML
 * walk can see it — is owed to the behavioural case beside case 4, which posts that target
 * with no field and reads the refusal.
 *
 * `/approvals` and `/approvals/<id>` left with decision 38's first family, and nothing is
 * owed for them: the two targets their forms posted (`/approvals/:op`, `/approvals/push`)
 * are deleted, and the JSON routes that replaced them are `X-Pmcp-Csrf`-gated — pinned by
 * the write-gate describe and by the push rows' own 403. The list shrinks with each family
 * and the walk retires with the last.
 */
async function sessionPages(): Promise<Record<string, string>> {
  const { userCode } = await requestDeviceCodes();
  const rendered: Record<string, string> = {};
  for (const path of [
    // All seven panes, not just the landing one: a pane is a route, and a form that forgot
    // its CSRF field on /settings/tokens is as unposted as one that forgot it on /settings.
    ...PANES,
    `${paths.device}?user_code=${encodeURIComponent(userCode)}`,
  ]) {
    rendered[path] = await page(path);
  }
  return rendered;
}

/**
 * The export, parsed — one AuditRow per line, exactly as audit.exportJsonl frames it.
 * Takes URLSearchParams rather than a record, because the keys the export accepts are
 * REPEATED ones (decision 36) and a record can hold each name only once.
 */
async function exportLines(search: URLSearchParams): Promise<AuditRow[]> {
  const response = await get(`${paths.auditExport}?${search.toString()}`);
  expect(response.status).toBe(200);
  // Decoded rather than `.text()`d: the export declares application/x-ndjson, and
  // workerd warns when a body it does not consider text is read as one.
  const body = new TextDecoder().decode(await response.arrayBuffer());
  return body
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as AuditRow);
}

/**
 * §15's hygiene on one recorded row, checked the way a reader of the ledger can check it.
 * An auth event is a FACT about a credential, never a copy of one, so three things hold at
 * once: the row carries no body columns at all (`auth.*` events have no bodies to carry —
 * only `tools/call` rows do), nothing in it matches token material or names an
 * `Authorization` header, and none of the secrets the request that produced it carried
 * survives into it. `secrets` is what THAT request held — asserted non-empty, because a
 * blank needle finds nothing and passes.
 */
function hygienic(row: AuditRow, secrets: string[]): void {
  expect(row.args, `${row.event} recorded an args body`).toBeUndefined();
  expect(row.result, `${row.event} recorded a result body`).toBeUndefined();
  expect(row.detail, `${row.event} recorded a detail`).toBeUndefined();
  const serialized = JSON.stringify(row);
  expect(serialized, `${row.event} carries token material`).not.toMatch(TOKEN_MATERIAL);
  expect(serialized.toLowerCase(), `${row.event} names an Authorization header`).not.toContain(
    "authorization",
  );
  for (const secret of secrets) {
    expect(secret.length, "an empty secret proves nothing").toBeGreaterThan(0);
    expect(serialized, `${row.event} carries a value its own request submitted`).not.toContain(secret);
  }
}

/** Token MATERIAL rather than the §5 display prefix — the length floor is what separates
 *  them (hygiene.test.ts states the whole reasoning); the prefixes come from the leaf that
 *  mints them, never transcribed here. */
const TOKEN_MATERIAL = tokenPattern(16);

/* ------------------------------------------------------------------ *
 * Panes behind a rail (§13)
 * ------------------------------------------------------------------ */

/**
 * The accessible names of the two pane navigations each paned page renders. They are the
 * ONLY thing that tells them apart from each other and from the shell header, which
 * repeats `/settings` in every signed-in page — a walk that collected anchors by href
 * would read three navs as one. Spelled here and in the page; that agreement IS the pin.
 */
const RAIL_NAV_LABEL = "Settings panes";
const PILL_NAV_LABEL = "Settings panes, compact";
const APP_RAIL_NAV_LABEL = "App panes";
const APP_PILL_NAV_LABEL = "App panes, compact";

/** §13's seven settings panes in rail order, read through `paths` and never respelled. */
const PANES: readonly string[] = [
  paths.settings,
  paths.settingsTwoFactor,
  paths.settingsPasskeys,
  paths.settingsSessions,
  paths.settingsTokens,
  paths.settingsClients,
  paths.settingsExecution,
];

/** One entry of a pane navigation. `marker` is "" when the entry carries none, which is
 *  §13's `none` cell said as an absence a walk can see. */
type RailEntry = { href: string; label: string; marker: string; current: boolean };

/**
 * The entries of ONE named pane navigation, in the order it drew them. Narrowing by the
 * nav's accessible name first is what makes this readable at all: `/settings` appears in
 * the shell header of every signed-in page and in both of this page's navigations.
 *
 * Inside an entry the walk reads STRUCTURE, never a class: an entry is one anchor holding
 * a label element and, when the pane has a marker, a trailing marker element.
 */
function railEntries(html: string, navLabel: string): RailEntry[] {
  const block = navBlock(html, navLabel);
  if (block === null) return [];
  const entries: RailEntry[] = [];
  for (const anchor of block.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    const parts = topLevelElements(anchor[2]);
    entries.push({
      href: decodeEntities(attributeOf(anchor[1], "href") ?? ""),
      label: textOf(parts[0] ?? anchor[2]),
      marker: parts.length > 1 ? textOf(parts[parts.length - 1]) : "",
      current: attributeOf(anchor[1], "aria-current") === "page",
    });
  }
  return entries;
}

/** One named navigation's own markup, or null when the page rendered none. Narrowing to
 *  it is what keeps the rail, the pill row and the shell header from being read as one. */
function navBlock(html: string, navLabel: string): string | null {
  const nav = new RegExp(`<nav\\b[^>]*aria-label="${navLabel}"[^>]*>([\\s\\S]*?)</nav>`).exec(html);
  return nav === null ? null : nav[1];
}

/**
 * The element children of one element's inner HTML, at depth zero — how "the label and,
 * after it, the marker" is read without naming a class. Every tag a rail entry contains
 * is paired (`<span></span>`, never a void element), which is what lets a depth counter
 * stand in for a parser here.
 */
function topLevelElements(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (const tag of inner.matchAll(/<(\/?)[a-zA-Z][^>]*>/g)) {
    if (tag[1] === "") {
      if (depth === 0) start = tag.index;
      depth += 1;
    } else {
      depth -= 1;
      if (depth === 0) parts.push(inner.slice(start, tag.index + tag[0].length));
    }
  }
  return parts;
}

/**
 * A fragment's TEXT: tags dropped, entities decoded, whitespace collapsed. The prose
 * decoder, deliberately not `decodeEntities` — that one documents itself as the URL
 * decoder every action and href goes through, and text carries `&#39;` and friends a URL
 * never does (Hono escapes `& < > " '` in every text child).
 *
 * A tag becomes a SPACE rather than nothing, because the renderer emits no whitespace
 * between sibling elements: two adjacent `<span>`s would otherwise read as one word, and
 * a row asserting on a §13 sentence spread across two elements would be asserting on a
 * string no reader ever sees. The collapse below puts every run back to one space, and
 * the last step takes it off again in front of sentence punctuation — a §13 sentence
 * whose code span is followed by a comma or a full stop (`answers -32601, because …`)
 * renders as one element and one text node, and the space the closing tag left is
 * likewise a string no reader ever sees.
 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)))
    .replace(/&(?:amp|lt|gt|quot|#x27|#039|apos);/g, (entity) => PROSE_ENTITIES[entity] ?? entity)
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .trim();
}

const PROSE_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#x27;": "'",
  "&#039;": "'",
  "&apos;": "'",
};

function formsOn(html: string): string[] {
  const actions: string[] = [];
  for (const form of html.matchAll(/<form\b([^>]*)>/g)) {
    if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
    actions.push(decodeEntities(attributeOf(form[1], "action") ?? ""));
  }
  return actions.sort();
}

/**
 * Every POST target the seven panes render, with the pane that drew it and the submission it
 * drew — including the ones that exist only under `?confirm=`, which is where §13 puts
 * Disable two-factor, Remove passkey, Revoke session, Revoke all others and the clients
 * pane's Revoke. A walk over the bare panes alone would see none of those five.
 */
async function settingsPostTargets(
  cookie: string,
): Promise<Map<string, { pane: string; fields: Record<string, string> }>> {
  const found = new Map<string, { pane: string; fields: Record<string, string> }>();
  for (const pane of PANES) {
    const bare = await page(pane, cookie);
    for (const href of [null, ...confirmLinksOn(bare)]) {
      const html = href === null ? bare : await page(href, cookie);
      for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
        if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
        const action = decodeEntities(attributeOf(form[1], "action") ?? "");
        if (!action.startsWith(`${paths.settings}/`)) continue;
        found.set(action, { pane, fields: submissionOf(form[2]) });
      }
    }
  }
  return found;
}

/**
 * One connected client, made the only way one is ever made: a real registration, a real
 * authorize, and the consent screen's own form posted with an agent chosen. Nothing here
 * plants an `oauth_binding` row by hand — a fixture that did would pin a shape rather
 * than a behavior.
 */
async function consentOnce(
  ns: SeededNamespace,
  cookie: string,
  agentSlug: string,
  fields: Record<string, unknown> = {},
  /** The cookie that REGISTERS the client, when the row needs a pre-registered one: DCR
   *  (no cookie, `oauthClient.userId` null) is what §19.3's "unverified" marker is about,
   *  and its twin is the same flow with the owner's own session on the registration. */
  registrar?: string,
): Promise<{ clientId: string; bindingId: string }> {
  const { clientId } = await registerOAuthClient(fields, registrar);
  // A client that registered its OWN redirect URI must authorize with that URI: the
  // provider matches it exactly, so `authorizeUrl`'s default would be refused before any
  // consent screen exists. Derived here rather than passed, so no caller can forget it.
  const registered = Array.isArray(fields.redirect_uris) ? String(fields.redirect_uris[0]) : null;
  const { html, oauthQuery } = await reachConsent(clientId, cookie, {
    resource: oauthResourceFor(ns.owner.username),
    ...(registered === null ? {} : { redirect_uri: registered }),
  });
  const accepted = await post(
    paths.oauthConsent,
    { oauth_query: oauthQuery, decision: "accept", agent: agentSlug },
    { cookie, csrf: csrfOf(html) },
  );
  expect(accepted.status, await accepted.text()).toBe(303);
  const binding = await bindingFor(ns.owner.userId, clientId);
  expect(binding, "the consent POST wrote no binding").not.toBeNull();
  return { clientId, bindingId: binding?.id ?? "" };
}

/** `/api/whoami` under one bearer — how a CLI session is asked whether it is still alive. */
function whoami(token: string): Promise<Response> {
  return call(new Request(`${ORIGIN}/api/whoami`, { headers: { Authorization: `Bearer ${token}` } }));
}

/** Whether a password still opens the door — /login's own form, posted as a browser posts
 *  it. The postcondition every refused credential change is measured by. */
async function signsIn(username: string, password: string): Promise<boolean> {
  const answered = await formPost(paths.auth.signIn, { username, password });
  return sessionCookieOf(answered) !== null;
}

/**
 * The row ids the controls fronting one op NAME, as a set — never a count, because a
 * responsive pane may legally draw one row as two forms and §13 pins no control count.
 * The id is read from whichever place the target puts it: the action's `id` query
 * parameter (the final-segment convention every ops-backed target follows) or a hidden
 * control named `id` (what a dialog's form carries). Which of the two a page chose stays
 * the direction-B row's business.
 */
function revokeTargets(html: string, op: string): Set<string> {
  const found = new Set<string>();
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
    const url = new URL(decodeEntities(attributeOf(form[1], "action") ?? ""), ORIGIN);
    if ((url.pathname.split("/").filter(Boolean).pop() ?? "") !== op) continue;
    const id = url.searchParams.get("id") ?? submissionOf(form[2]).id ?? "";
    if (id !== "") found.add(id);
  }
  return found;
}

/**
 * The one rendered control that names a row id: where it posts, the submission a browser
 * would send (the CSRF token included, as rendered), and THE WORD on its submit button —
 * §13's Revoke-vs-Remove is a label, and a label nothing reads is a claim nothing checks.
 * Throws rather than returning null: a page that draws no such control is a page whose
 * journey the walk can no longer describe.
 */
function controlFor(
  html: string,
  id: string,
): { action: string; fields: Record<string, string>; label: string } {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
    const action = decodeEntities(attributeOf(form[1], "action") ?? "");
    const fields = submissionOf(form[2]);
    if (new URL(action, ORIGIN).searchParams.get("id") !== id && fields.id !== id) continue;
    const button = /<button\b[^>]*>([\s\S]*?)<\/button>/.exec(form[2]);
    return { action, fields, label: textOf(button?.[1] ?? "") };
  }
  throw new Error(`the page rendered no control naming "${id}"`);
}

/**
 * One pane's WHOLE control surface: its own render joined with every `?confirm=` render it
 * links to. §13 puts the Connected clients pane's Revoke — and four credential controls —
 * behind a dialog that exists only under the query, so a walk over the bare pane sees none
 * of them. Joined rather than parsed, because the only walks that read this are form walks.
 */
async function paneWithDialogs(pane: string, cookie: string): Promise<string> {
  const bare = await page(pane, cookie);
  const dialogs: string[] = [];
  for (const href of confirmLinksOn(bare)) dialogs.push(await page(href, cookie));
  return [bare, ...dialogs].join("\n");
}

/** `token_list`'s own answer for one namespace — the truth side of every Tokens-pane row,
 *  and the only place a key's display prefix comes from (`SeededToken` carries none). */
async function tokensOf(ownerId: string): Promise<TokenInfo[]> {
  return ((await ops.token_list.handler(ownerId, {})) as { tokens: TokenInfo[] }).tokens;
}

/** The same for `connection_list`, which since D15 reports revoked bindings too (§8). */
async function connectionsOf(ownerId: string): Promise<ConnectionRow[]> {
  return ((await ops.connection_list.handler(ownerId, {})) as { connections: ConnectionRow[] })
    .connections;
}

/** One pane's rail marker, read off the RAIL rather than off "the anchor with that href"
 *  — the pill row repeats every href markerless, and `Number("")` is 0, not NaN. */
function markerOf(html: string, href: string): string {
  const entry = railEntries(html, RAIL_NAV_LABEL).find((row) => row.href === href);
  if (entry === undefined) throw new Error(`the rail carries no entry for "${href}"`);
  return entry.marker;
}

/**
 * A registration's passkey row, minus the ceremony: no test can perform WebAuthn, so the
 * row is written the way the plugin would write it (its columns, ISO dates) and everything
 * asserted afterwards goes through the page's own links, forms and the real route.
 *
 * `name` is OPTIONAL and `aaguid` is writable because those two together are what a real
 * registration produces: /settings' Add-passkey ceremony sends no name at all, and the
 * plugin writes an aaguid on every registration. A row with a stored name is the state a
 * hand-named credential is in — which the model's name rule keeps as its first term, and
 * which every other call site here is still exercising.
 */
async function plantPasskey(
  userId: string,
  fields: { name?: string | null; aaguid?: string; createdAt?: string; credentialId?: string },
): Promise<string> {
  const id = uniqueSlug("pk");
  await (env.DB as D1Like)
    .prepare(
      `INSERT INTO "passkey" ("id", "name", "aaguid", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt")
       VALUES (?, ?, ?, 'pk', ?, ?, 0, 'singleDevice', 0, ?)`,
    )
    .bind(
      id,
      fields.name ?? null,
      fields.aaguid ?? null,
      userId,
      // Nameable, because §5's stamp is keyed by the CREDENTIAL id an assertion carries
      // and a row that cannot say its own cannot check which passkey was stamped.
      fields.credentialId ?? uniqueSlug("cred"),
      fields.createdAt ?? new Date().toISOString(),
    )
    .run();
  return id;
}

/** §5's `last_used_at` for one credential, read from the column itself — the only
 *  in-process way to say the stamp is keyed by credential id and not by user. */
async function lastUsedOf(credentialId: string): Promise<number | null> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "last_used_at" FROM "passkey" WHERE "credentialID" = ?`)
    .bind(credentialId)
    .first<{ last_used_at: number | null }>();
  return row?.last_used_at ?? null;
}

/**
 * Whether a string appears inside any `action="…"` or `href="…"` attribute value. That is
 * the structural way to say "this endpoint is named in a script rather than in a control":
 * slicing `<script>` spans instead would be a grip on markup, not on the claim.
 */
function inNavigableAttribute(html: string, value: string): boolean {
  for (const attribute of html.matchAll(/\b(?:action|href)="([^"]*)"/g)) {
    if (decodeEntities(attribute[1]).includes(value)) return true;
  }
  return false;
}

/** One form's action, as the page rendered it — how case 19 posts to a target it
 *  discovered rather than to one it spelled. */
function actionFor(html: string, op: string): string {
  const action = new RegExp(`(?:form)?action="([^"]*/${op}(?:\\?[^"]*)?)"`).exec(html)?.[1];
  if (action === undefined) throw new Error(`no rendered action for "${op}"`);
  return decodeEntities(action);
}

/** How many state rows one connect flow still has — "stores nothing" made observable. */
async function stateRows(state: string): Promise<number> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT COUNT(*) AS n FROM upstream_oauth_state WHERE state = ?`)
    .bind(state)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** An app's upstream connection state, read the way /apps reads it. */
async function connectionOf(slug: string): Promise<string> {
  const listed = (await ops.app_list.handler(world.ns.owner.userId, {})) as {
    apps: { slug: string; connection?: string }[];
  };
  return listed.apps.find((row) => row.slug === slug)?.connection ?? "not_connected";
}

/**
 * Everything a page mutation could have changed, as one comparable value: the apps
 * and their flags, the approvals and their statuses. Case 19 compares it across a POST
 * whose op did nothing — if the page layer wrote to D1 itself, this moves.
 */
async function namespaceShape(): Promise<string> {
  const apps = await (env.DB as D1Like)
    .prepare(
      `SELECT id, slug, archived_at, upstream_auth_json IS NOT NULL AS sealed
         FROM app WHERE owner_id = ? ORDER BY slug`,
    )
    .bind(world.ns.owner.userId)
    .all<Record<string, unknown>>();
  const approvals = await (env.DB as D1Like)
    .prepare(`SELECT id, status FROM approval WHERE owner_id = ? ORDER BY id`)
    .bind(world.ns.owner.userId)
    .all<Record<string, unknown>>();
  return JSON.stringify({ apps: apps.results, approvals: approvals.results });
}

/**
 * How often a name is NAMED in some text. Occurrences preceded by a word character do not
 * count, which is what keeps §7's aggregated `<slug>_<tool>` from reading as a second
 * mention of the tool inside it — and, unlike a trailing `\b`, it still finds a URI
 * template that ends in `}`.
 */
function mentionPattern(name: string): RegExp {
  return new RegExp(`(?<!\\w)${name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`, "g");
}

function mentions(text: string, name: string): number {
  return [...text.matchAll(mentionPattern(name))].length;
}

/**
 * One block of text per listed name: asserts each name is mentioned exactly once and in
 * listing order, then slices between one and the next. That is what makes a per-item claim
 * an assertion about ITS item — a page printing one line for everything fails here rather
 * than passing every block. It keys on the listed names alone and takes no markup grip.
 */
function blocksOf(text: string, names: readonly string[]): Record<string, string> {
  const at = names.map((name) => {
    const found = [...text.matchAll(mentionPattern(name))].map((match) => match.index ?? -1);
    expect(found.length, `"${name}" is named ${found.length} times, not once`).toBe(1);
    return found[0];
  });
  for (let index = 1; index < at.length; index += 1) {
    expect(at[index], `"${names[index]}" is not listed after "${names[index - 1]}"`).toBeGreaterThan(
      at[index - 1],
    );
  }
  const blocks: Record<string, string> = {};
  names.forEach((name, index) => {
    blocks[name] = text.slice(at[index], index + 1 < at.length ? at[index + 1] : text.length);
  });
  return blocks;
}

/** Every target a page posts to, `action=` and a submit button's `formaction=` alike —
 *  /apps draws Connect as the latter, so a walk over form actions alone would miss the
 *  very control the app page's own is compared against. */
function postTargets(html: string): string[] {
  return [...html.matchAll(/(?:form)?action="([^"]*)"/g)].map((match) => decodeEntities(match[1]));
}

/** The text of every anchor pointing at `href` — a tab's own count read without naming
 *  the element that draws it. Plural because both pane navigations point at the same URLs
 *  and are anchors too. */
function linkTexts(html: string, href: string): string[] {
  const found: string[] = [];
  for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (decodeEntities(attributeOf(anchor[1], "href") ?? "") === href) found.push(textOf(anchor[2]));
  }
  return found;
}
