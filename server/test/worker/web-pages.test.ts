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
// Family 2, `/settings`: the seven panes are the shell behind the unchanged recent-auth
// prefix; every row that read a pane's markup for a server fact reads `GET /api/hub/settings`
// instead, and every row that posted a pane's form posts its `/api/hub/settings/*` JSON twin,
// whose `{ next, reload }` answer carries the Location the 303 named. What a row pinned
// about DRAWING (the rail, the pills, the dialogs, the copy) is the client's, and each such
// row is retired where it stood with a comment naming its web-side home.
// Family 3, `/device`: the shell behind the ordinary session; the confirm card's facts are
// `GET /api/hub/device`, which makes the same claiming verify call the render made, and the
// verdict is `POST /api/hub/device/decide` (28, 29 and 31 ported). The binding the render
// had — the first signed-in reader claims the code, only the claimant sees its client and
// only the claimant can decide — is pinned on the read and the decide themselves.
// Family 4, `/oauth/consent`: the shell runs the provider's signature check before any
// HTML (a refused query is still the plain 400), the screen's strings are
// `GET /api/hub/oauth/consent` over the same raw query, and the POST is unchanged — its rows
// read the CSRF token off `#pmcp-bootstrap` now, since the client draws the form.
// Family 5, `/login`: the shell with no gate and no `#pmcp-bootstrap`, carrying the
// `#pmcp-login` island — the step and the ONE landing, computed on the server as the page
// computed them — so every row that read the page's cards or its passkey script reads the
// island instead, and posts the three kept sign-in routes at the targets the SPA's own path
// table names. No server-rendered page is left.
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
// declares none: one side is what a surface ADMITS, measured, the other read off
// admin.ops[name].schema. A transcribed form→field list would be a third copy of the
// truth, and maintaining it is precisely the drift Direction B exists to catch. No server
// form fronts an op any more (decision 38 moved the last of them), so it is the ops
// allowlist walk (18), the op's own schema refusal behind it (18b) and the settings
// writes' extra-key refusal — what the router admits, never a list copied out of api.ts.
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
import { beforeAll, describe, expect, it, vi } from "vitest";
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
  DEVICE_CODE_TTL_MS,
  HUB_HARD_MAX_TIMEOUT_MS,
  HUB_MIN_TIMEOUT_MS,
  RETENTION_DAYS,
} from "../../src/limits";
import { generatedAlias } from "../../src/hub-types";
import { paths } from "../../src/pages/model";
// The SPA's own path table, compared against the worker's: the two are separate modules, and
// a React form posting to a route the worker does not translate is invisible to any test that
// reads server HTML (24a). `settingsApi` is the same table's JSON half — every `/api/hub`
// target the settings pages call, walked by case 24. `loginUrl` is how the client builds
// /login's card-switch links, which the landing rows follow as a browser follows them.
import {
  consentApi,
  deviceApi,
  loginUrl as webLoginUrl,
  passkeyAuthentication,
  settingsApi,
  paths as webPaths,
} from "../../../web/src/lib/paths";
import type { ConsentRead, DeviceRead, SettingsRead } from "../../src/api";
import type { ConnectionRow, LoginIsland } from "../../src/pages/model";
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

/**
 * The CSRF token a SHELL document bootstrapped — the only place a browser gets one, and so
 * the only place a test may: since decision 38's family 4 no server page renders a CSRF
 * field (the consent form's is drawn by the client from this island). The session's token
 * rides a `<script type="application/json" id="pmcp-bootstrap">` island that the client
 * parses on mount.
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

/** `#pmcp-login`'s text exactly as the document carries it, before any parse — for the rows
 *  that ask what the ESCAPING did to a caller's query (routes §0.2). */
function loginIslandTextOf(html: string): string {
  const island = /<script type="application\/json" id="pmcp-login">([\s\S]*?)<\/script>/.exec(html);
  if (island === null) throw new Error("the document carried no #pmcp-login island");
  return island[1];
}

/** `#pmcp-login`, parsed as the client parses it: /login's step, and the ONE landing both of
 *  its consumers read — the `callbackURL` its cards post and the passkey ceremony's
 *  navigation — with null meaning the client's "/apps". */
function loginIslandOf(html: string): LoginIsland {
  return JSON.parse(loginIslandTextOf(html)) as LoginIsland;
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

/** A session's own CSRF token, read where a browser reads it: a shell's bootstrap island.
 *  Off `/apps` because that shell has no recency gate, so a day-old session still gets its
 *  token there — which is what lets a stale-session row prove the GATE refused it. */
async function csrfFor(cookie: string): Promise<string> {
  return bootstrapCsrfOf(await page(paths.apps, cookie));
}

/** `GET /api/hub/settings` under one cookie — the one read every settings pane draws from
 *  (§13's shell rule), and the truth side of every row that used to read a pane's markup. */
async function settingsOf(cookie: string): Promise<SettingsRead> {
  const answered = await hub("GET", "/api/hub/settings", undefined, { cookie });
  expect(answered.status, "GET /api/hub/settings").toBe(200);
  return (await answered.json()) as SettingsRead;
}

/** One `/api/hub/settings/*` write as the SPA makes it — `path` relative to `/api/hub`, the
 *  way `settingsApi` spells it — with the session's own token unless the case withholds it. */
async function settingsPost(
  path: string,
  body: unknown,
  cookie: string,
  csrf?: string | null,
): Promise<Response> {
  const token = csrf === undefined ? await csrfFor(cookie) : csrf;
  return hub("POST", `/api/hub${path}`, body, { cookie, ...(token === null ? {} : { csrf: token }) });
}

/**
 * A `{ next, reload }` answer (routes §0.3), checked the way every one of them must hold:
 * 200, exactly those two keys, and `reload` true exactly when the answer forwards a
 * `Set-Cookie` — the session, and with it the CSRF token the document holds, was replaced.
 * `next` comes back parsed, because every caller asks which pane it names and which flash.
 */
async function redirectedOf(response: Response): Promise<{ next: URL; reload: boolean; raw: string }> {
  const text = await response.clone().text();
  expect(response.status, text).toBe(200);
  const body = await jsonOf(response);
  expect(Object.keys(body).sort(), text).toEqual(["next", "reload"]);
  expect(typeof body.next, text).toBe("string");
  expect(body.reload, `reload says ${String(body.reload)} beside ${response.headers.getSetCookie().length} Set-Cookie`).toBe(
    response.headers.getSetCookie().length > 0,
  );
  return { next: new URL(String(body.next), ORIGIN), reload: body.reload === true, raw: String(body.next) };
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
 * The Password pane's submission as the SPA sends it (routes §2): the three controls, and
 * the **Sign out my other sessions** box TICKED unless the case says otherwise — §13's
 * default-on, which the client's form starts from too. Every change-password row builds its
 * body here, so two rows differ only in what they pass.
 */
function passwordChange(fields: {
  currentPassword: string;
  newPassword: string;
  confirmPassword?: string;
  revokeOtherSessions?: boolean;
}): Record<string, unknown> {
  return {
    currentPassword: fields.currentPassword,
    newPassword: fields.newPassword,
    confirmPassword: fields.confirmPassword ?? fields.newPassword,
    revokeOtherSessions: fields.revokeOtherSessions ?? true,
  };
}

/**
 * Every `/api/hub/settings/*` write routes §2 designs, each with the body a browser would
 * send when the case is about the GATE rather than the write — a password that is not the
 * owner's, so the four routes that take one refuse on the merits, and the ids the world
 * names. Keyed off `settingsApi`, the SPA's own table, so a write the client stops calling
 * leaves this list with it. `pane` is the pane that draws the control, and so the one the
 * answer's `next` must land on (§13's "mutations belong to a pane"); `op` is the ops key
 * the route fronts, null where it is better-auth's (§8's pinned exception).
 */
function settingsWrites(ids: {
  passkey?: string;
  session?: string;
  token?: string;
  connection?: string;
} = {}): { path: string; pane: string; op: string | null; body: Record<string, unknown> }[] {
  return [
    { path: settingsApi.totpEnable, pane: paths.settingsTwoFactor, op: null, body: { password: WRONG_PASSWORD } },
    { path: settingsApi.totpVerify, pane: paths.settingsTwoFactor, op: null, body: { code: "000000" } },
    { path: settingsApi.totpDisable, pane: paths.settingsTwoFactor, op: null, body: { password: WRONG_PASSWORD } },
    { path: settingsApi.backupCodesGenerate, pane: paths.settingsTwoFactor, op: null, body: { password: WRONG_PASSWORD } },
    { path: settingsApi.passkeyDelete, pane: paths.settingsPasskeys, op: null, body: { id: ids.passkey ?? "no-such-passkey" } },
    { path: settingsApi.sessionRevoke, pane: paths.settingsSessions, op: null, body: { id: ids.session ?? "no-such-session" } },
    {
      path: settingsApi.changePassword,
      pane: paths.settings,
      op: null,
      body: passwordChange({ currentPassword: WRONG_PASSWORD, newPassword: fakePassword(20), revokeOtherSessions: false }),
    },
    { path: settingsApi.tokenRevoke, pane: paths.settingsTokens, op: "token_revoke", body: { id: ids.token ?? "no-such-token" } },
    { path: settingsApi.connectionRevoke, pane: paths.settingsClients, op: "connection_revoke", body: { id: ids.connection ?? "no-such-connection" } },
    {
      path: settingsApi.executionUpdate,
      pane: paths.settingsExecution,
      op: "hub_settings_update",
      body: { default_timeout_ms: "30000", max_timeout_ms: "30000" },
    },
    // LAST, and not by accident: it ends every other session of the owner posting it, so a
    // walk that ran it earlier would kill the sessions its remaining legs ride.
    { path: settingsApi.revokeOtherSessions, pane: paths.settingsSessions, op: null, body: {} },
  ];
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

  // Row 4's first half — "every mutating form the pages render carries a CSRF field",
  // walked out of `sessionPages()`'s server HTML — retired with decision 38's family 3: its
  // last page, /device, answers the shell now, and the list it walked is empty. Where the
  // guarantee went: the three form targets that survive each have a row that posts WITHOUT
  // the field and is refused and WITH the session's own token and is admitted — the consent
  // POST (§19.5's CSRF row; since family 4 its token comes off the shell's bootstrap, as the
  // client's form takes it), /apps/connect (5b) — and /login's forms carry none by design (no
  // session yet; the origin rule stands in). Every JSON write carries the header instead,
  // which the write-gate describe pins.
  it("4. §13 · the write that replaced the last ops-backed form, posted without its `X-Pmcp-Csrf`, is refused with its op never reaching a handler — the token is READ, not decorative · the same write carrying the session's token reaches the op once (the twin)", async () => {
    // Ported with decision 38's family 2, which took the last ops-backed FORM with it:
    // `/settings/tokens/token_revoke` is `POST /api/hub/settings/tokens/token_revoke` now,
    // behind the same `{recent: true}` prefix, which this fresh session satisfies — so the
    // only thing left to refuse the post is the missing header, and it does.
    await withCountedOps(["token_revoke"], async (invocations) => {
      const refused = await settingsPost(settingsApi.tokenRevoke, { id: "no-such-token" }, world.session.cookie, null);
      expect(refused.status, "POST /api/hub/settings/tokens/token_revoke with no X-Pmcp-Csrf").toBe(403);
      expect(times(invocations, "token_revoke")).toBe(0);
      // The twin, so "403" is not what this route always answers.
      const accepted = await settingsPost(settingsApi.tokenRevoke, { id: "no-such-token" }, world.session.cookie);
      expect(accepted.status, await accepted.clone().text()).toBe(200);
      expect(times(invocations, "token_revoke")).toBe(1);
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
  it("6. §4 · a bearer-sourced (device-flow) session is refused on /settings and at GET /api/hub/settings · a browser session opens both (the twin — the guard is about provenance, not about being logged out)", async () => {
    const cookieName = world.session.cookie.split("=")[0];
    const deviceCookie = `${cookieName}=${world.deviceToken}`;
    const replayed = await get(paths.settings, deviceCookie);
    expect(replayed.status).toBe(302);
    expect(replayed.headers.get("Location")).toMatch(/^\/login(\?|$)/);
    // The same provenance rule on the JSON side (decision 38): the read the pane draws from.
    const read = await hub("GET", "/api/hub/settings", undefined, { cookie: deviceCookie });
    expect(read.status).toBe(401);
    // The twin: the same page and the same read, a browser session.
    const rendered = await get(paths.settings);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain('id="pmcp-bootstrap"');
    expect((await hub("GET", "/api/hub/settings")).status).toBe(200);
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

describe("§13 · /login is the shell (decision 38, family 5)", () => {
  it(`§13 · GET /login answers the SPA shell with NO gate — 200, no-store, a #pmcp-login island carrying the step and the landing the server page computed (its props minus the clock), and the tab title the step names ("Sign in", "Two-factor code", "Use a backup code") — and NO #pmcp-bootstrap even to a signed-in cookie, so no CSRF token and no username reach a document the query alone decides (the twin)`, async () => {
    const cases: [string, string, LoginIsland][] = [
      [
        `${paths.login}?username=alice&error=Wrong`,
        "Sign in",
        { step: { kind: "credentials", username: "alice", error: "Wrong" }, redirectTo: null },
      ],
      // `?step=` is what the credential routes send …
      [
        `${paths.login}?step=totp&next=${encodeURIComponent(paths.approvals)}`,
        "Two-factor code",
        { step: { kind: "totp", error: null }, redirectTo: paths.approvals },
      ],
      // … and `?method=` what a card switch sends: both draw the card asked for.
      [
        `${paths.login}?method=backup-code&error=Nope`,
        "Use a backup code",
        { step: { kind: "backup-code", error: "Nope" }, redirectTo: null },
      ],
    ];
    for (const [url, title, island] of cases) {
      const response = await call(new Request(`${ORIGIN}${url}`));
      expect(response.status, url).toBe(200);
      expect(response.headers.get("Cache-Control"), url).toBe("no-store");
      const html = await response.text();
      expect(html, url).toContain(`<title>${title}</title>`);
      expect(loginIslandOf(html), url).toEqual(island);
      expect(html, url).not.toContain('id="pmcp-bootstrap"');
    }

    // The twin: a signed-in cookie changes nothing. No gate means no session is read, so
    // nothing of one can reach the document — the island is the query's, and only that.
    const signedIn = await call(new Request(`${ORIGIN}${paths.login}`, { headers: { Cookie: world.session.cookie } }));
    expect(signedIn.status).toBe(200);
    const html = await signedIn.text();
    expect(html).not.toContain('id="pmcp-bootstrap"');
    expect(html).not.toContain(await csrfFor(world.session.cookie));
    expect(html).not.toContain(world.ns.owner.username);
    expect(loginIslandOf(html)).toEqual({ step: { kind: "credentials", username: "", error: null }, redirectTo: null });
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

  it("21. §13 · /login's own sign-in form, submitted as a browser submits it (application/x-www-form-urlencoded) to the target the SPA's path table names, lands a session cookie and a redirect — better-auth's endpoints allow application/json only, so a form posted straight at one answers 415 and no human ever signs in", async () => {
    // The card is the client's since decision 38's family 5, so its target is read out of
    // the table the client posts through — and it must be the Worker's translating route.
    expect(webPaths.signIn).toBe(paths.auth.signIn);
    const answered = await formPost(webPaths.signIn, {
      username: signer.owner.username,
      password: SEEDED_OWNER_PASSWORD,
      // Deliberately NOT the default landing page: /apps is also where a missing or
      // refused callbackURL falls back to, so asserting it would pass either way. This is
      // the deep link /login carries through the round trip (LoginIsland.redirectTo).
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

  it("22. §15 · a wrong password lands back on /login, whose #pmcp-login island carries the credentials card's field error, and sets NO session cookie (the refusal twin of 21) — and the password appears in neither the redirect, the document nor the island", async () => {
    const wrong = "FAKE0000-not-the-seeded-password";
    const answered = await formPost(webPaths.signIn, {
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
    const island = loginIslandOf(rerendered);
    // The credentials card, redrawn with its error and the username echoed back so only
    // the password is retyped (LoginStep's "credentials" arm).
    expect(island.step).toEqual({ kind: "credentials", username: signer.owner.username, error: expect.any(String) });
    expect(rerendered).not.toContain(wrong);
    expect(JSON.stringify(island)).not.toContain(wrong);
  });

  it("23. §4 · the TOTP and backup-code challenge forms are translated too: each posts form-encoded to the hub route the SPA's path table names, which answers a redirect back to its own /login step — an island of that step carrying its error — never better-auth's 415", async () => {
    for (const [step, target, own] of [
      ["totp", webPaths.totpVerify, paths.auth.totpVerify],
      ["backup-code", webPaths.backupCodeVerify, paths.auth.backupCodeVerify],
    ] as const) {
      expect(target).toBe(own);
      // The card the form sits on is this step's island.
      expect(loginIslandOf(await anonymousPage(`${paths.login}?step=${step}`)).step).toEqual({ kind: step, error: null });
      const answered = await formPost(target, { code: "000000", callbackURL: paths.apps });
      expect(answered.status, `POST ${target}`).toBe(303);
      // No challenge is pending, so this is the refusal leg: back to the same card, with a
      // message and without a session.
      const to = answered.headers.get("Location") ?? "";
      expect(to).toContain(`step=${step}`);
      expect(sessionCookieOf(answered)).toBeNull();
      expect(loginIslandOf(await anonymousPage(to)).step).toEqual({ kind: step, error: expect.any(String) });
    }
  });

  // 24 walked the credential forms the SERVER drew, which is exactly why it stayed green while
  // the React shell's Sign out posted at better-auth's 415 for a month (routes §7.1). Replaced
  // with decision 38's family 2 by the walk that would have caught it: the targets are read
  // out of the SPA's own path table, the one the client posts through, never out of HTML.
  it("24. §13 · every target the SPA's own path table names answers as designed — each FORM target it renders (Sign out, Connect, /login's three cards) is one of the kept form routes and answers a form-encoded post with a 303, never 415 or 404; and `settingsApi` is exactly the settings read plus the eleven writes routes §2 designs, the read answering 200 and each write answering its JSON body with a designed answer (200 or 422 JSON), never 404, 415 or a 5xx; and `deviceApi` is the device read and verdict routes §3 designs and `consentApi` the consent read routes §4 designs, each answering its designed JSON", async () => {
    // A NAMESPACE of this case's own: Sign out and Revoke all others both succeed, and each
    // ends sessions of whichever owner it rides.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent" }],
    });
    const walker = await seedOwnerSession(ns.owner);
    const csrf = await csrfFor(walker.cookie);

    // THE FORM HALF. §0.4's kept form routes are the only targets a client form may post,
    // and since family 5 the bundle renders all of them but the consent POST (its rows post
    // it as a browser does): Sign out, Connect and /login's three cards.
    const KEPT_FORM_ROUTES = new Set([
      paths.auth.signOut,
      paths.auth.signIn,
      paths.auth.totpVerify,
      paths.auth.backupCodeVerify,
      new URL(paths.appConnect(""), ORIGIN).pathname,
    ]);
    // Each with the fields its form renders. The /login cards post with no session, as a
    // browser there has none, and with credentials that are wrong on purpose — each answers
    // its refusal 303 and no session moves. Sign out LAST: it ends the session the Connect
    // post rides.
    const submissions: [string, Record<string, string>, string | undefined][] = [
      [webPaths.signIn, { username: ns.owner.username, password: "FAKE0000-wrong", callbackURL: paths.apps }, undefined],
      [webPaths.totpVerify, { code: "000000", callbackURL: paths.apps }, undefined],
      [webPaths.backupCodeVerify, { code: "FAKE0-CODE0", callbackURL: paths.apps }, undefined],
      [webPaths.appConnect("news"), { csrf }, walker.cookie],
      [webPaths.signOut, {}, walker.cookie],
    ];
    for (const [target, fields, cookie] of submissions) {
      expect(KEPT_FORM_ROUTES.has(new URL(target, ORIGIN).pathname), `${target} is no kept form route`).toBe(true);
      const answered = await formPost(target, fields, cookie);
      expect(answered.status, `POST ${target} form-encoded → ${await answered.clone().text()}`).toBe(303);
    }

    // THE JSON HALF, spelled once against routes §2, as the pane strings are in the shell
    // describe: every other row reads these through `settingsApi`, so a renamed member
    // would otherwise leave the whole suite green.
    expect({ ...settingsApi }).toEqual({
      read: "/settings",
      totpEnable: "/settings/two-factor/enable",
      totpVerify: "/settings/two-factor/verify-totp",
      totpDisable: "/settings/two-factor/disable",
      backupCodesGenerate: "/settings/two-factor/generate-backup-codes",
      passkeyDelete: "/settings/passkey/delete-passkey",
      sessionRevoke: "/settings/revoke-session",
      revokeOtherSessions: "/settings/revoke-other-sessions",
      changePassword: "/settings/change-password",
      tokenRevoke: "/settings/tokens/token_revoke",
      connectionRevoke: "/settings/clients/connection_revoke",
      executionUpdate: "/settings/execution/hub_settings_update",
    });
    const reader = await seedOwnerSession(ns.owner);
    expect((await hub("GET", `/api/hub${settingsApi.read}`, undefined, { cookie: reader.cookie })).status).toBe(200);
    const writes = settingsWrites();
    expect(writes.map((write) => write.path).sort()).toEqual(
      Object.values(settingsApi).filter((path) => path !== settingsApi.read).sort(),
    );
    for (const { path, body } of writes) {
      const answered = await settingsPost(path, body, reader.cookie);
      const text = await answered.clone().text();
      expect([200, 422], `POST ${path} → ${answered.status} ${text}`).toContain(answered.status);
      expect(answered.headers.get("Content-Type") ?? "", `POST ${path}`).toContain("application/json");
      expect(answered.headers.get("Location"), `POST ${path} answered a redirect`).toBeNull();
    }

    // `deviceApi` (family 3), spelled once the same way, and each call answering its
    // designed JSON over a live code: the read 200 with the card, the verdict `{ next }`.
    expect({ ...deviceApi }).toEqual({ read: "/device", decide: "/device/decide" });
    const codes = await requestDeviceCodes();
    const read = await hub("GET", `/api/hub${deviceApi.read}?user_code=${encodeURIComponent(codes.userCode)}`, undefined, {
      cookie: reader.cookie,
    });
    expect(read.status, `GET ${deviceApi.read} → ${await read.clone().text()}`).toBe(200);
    const decided = await hub("POST", `/api/hub${deviceApi.decide}`, { userCode: codes.userCode, decision: "deny" }, {
      cookie: reader.cookie,
      csrf: await csrfFor(reader.cookie),
    });
    expect((await redirectedOf(decided)).raw).toBe(`${paths.device}?decided=denied`);

    // `consentApi` (family 4), the same way: its read, over a query the provider really
    // signed and appended verbatim, answers the screen. The consent POST is a kept form
    // route (routes §0.4), which the form rows above post as a browser does.
    expect({ ...consentApi }).toEqual({ read: "/oauth/consent" });
    const { clientId } = await registerOAuthClient();
    const { oauthQuery } = await reachConsent(clientId, reader.cookie, { resource: oauthResourceFor(ns.owner.username) });
    const consent = await hub("GET", `/api/hub${consentApi.read}?${oauthQuery}`, undefined, { cookie: reader.cookie });
    expect(consent.status, `GET ${consentApi.read} → ${await consent.clone().text()}`).toBe(200);
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

  it("27. §4/§13 · /settings's Enable two-factor and Regenerate backup codes send the password field the credential seam reads — each JSON body, as the SPA builds it, is ACCEPTED by better-auth and answered with its reveal instead of refused for a field no browser could send", async () => {
    const owner = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(owner.owner);

    // Not enrolled, so Enable is the one control the pane offers.
    const enabled = await settingsPost(settingsApi.totpEnable, { password: SEEDED_OWNER_PASSWORD }, session.cookie);
    // 200 with the enrolment, not `{ next }`: better-auth accepted the password this body
    // carried and its answer IS the reveal (a secret cannot ride a URL, §15). The refusal
    // leg is the prefix walk's, where a wrong password comes back with `failed=` in `next`.
    expect(enabled.status, await enabled.clone().text()).toBe(200);
    const enrolment = await jsonOf(enabled);
    expect(Object.keys(enrolment).sort()).toEqual(["backupCodes", "enrollment"]);

    // The enable above created the two-factor row; this makes it live, which is the only
    // state in which the pane offers Regenerate at all.
    await enrollTwoFactor(owner.owner.userId);
    const regenerated = await settingsPost(
      settingsApi.backupCodesGenerate,
      { password: SEEDED_OWNER_PASSWORD },
      session.cookie,
    );
    // Accepted, and the fresh set is revealed in the body for the same reason.
    expect(regenerated.status, await regenerated.clone().text()).toBe(200);
    expect(Object.keys(await jsonOf(regenerated))).toEqual(["backupCodes"]);
  });
});

describe("§4/§13/§15/§19.5 · /login's landing — one relative-only rule for both consumers", () => {
  // The landing has TWO consumers — the hidden callbackURL the three cards post and the
  // passkey ceremony's navigation after it verifies — and since decision 38's family 5 both
  // read ONE value, `#pmcp-login`'s `redirectTo`, computed once on the server (null is the
  // client's "/apps"). So the GET half of each row reads the island, and the posted half is
  // still `landingOf` at the kept sign-in route.

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
    `§15 · a hub-relative ?next=/apps%3C/script%3E%3Cimg src=x onerror=…%3E%E2%80%A8 — beside an ?error= and a ?username= carrying the same markup — reaches the #pmcp-login island escaped: no raw "<", U+2028 or U+2029 from the query anywhere in the shell, so "</script><img" appears nowhere in the document, while the island parses back to exactly what arrived — and ?next=/settings/tokens reaches it verbatim (the twin)`,
    async () => {
      // The payload PASSES the hub-relative rule on purpose — it starts "/a" — so it
      // reaches the island. Escaping, not refusal, is what this row is about; `error` and
      // `username` are the island's two other strings a link can set.
      const payload = "/apps</script><img src=x onerror=alert(1)>\u2028";
      const markup = "</script><img src=x onerror=alert(2)>\u2029";
      const html = await anonymousPage(`${paths.login}?${new URLSearchParams({ next: payload, error: markup, username: markup })}`);
      expect(html).not.toContain("</script><img");
      expect(html).not.toContain("<img src=x");
      expect(html).not.toContain("\u2028");
      expect(html).not.toContain("\u2029");
      // The island as the HTML parser reads it: no "<" at all, so nothing in it can end it.
      expect(loginIslandTextOf(html)).not.toContain("<");
      // Escaped, not truncated: the island still parses to exactly what arrived.
      expect(loginIslandOf(html)).toEqual({
        step: { kind: "credentials", username: markup, error: markup },
        redirectTo: payload,
      });

      // The twin: a relative deep link reaches the island byte for byte, so the escape
      // above is an escape and not a fallback wearing one's clothes.
      const clean = await anonymousPage(`${paths.login}?next=${encodeURIComponent(paths.settingsTokens)}`);
      expect(loginIslandOf(clean).redirectTo).toBe(paths.settingsTokens);
    },
  );

  // plan row 2. The posted arm names TWO spellings deliberately: an absolute callbackURL
  // already lands on /apps under a `startsWith("/")` test, so the backslash spelling is the
  // leg that fails without `hubRelative` — without it no row here gates the posted half.
  it(
    `§4 · ?next=https://evil.example, ?next=//evil.example, ?next=/%5Cevil.example (the backslash spelling a browser folds into //) and an empty ?next= each leave the #pmcp-login island's redirectTo null — the client's /apps — and reach no byte of the shell, and a sign-in POST carrying an absolute callbackURL, or that same backslash spelling, redirects to /apps too (the posted twin, one rule)`,
    async () => {
      for (const hostile of ["https://evil.example", "//evil.example", "/\\evil.example", ""]) {
        const html = await anonymousPage(`${paths.login}?next=${encodeURIComponent(hostile)}`);
        expect(loginIslandOf(html).redirectTo, hostile).toBeNull();
        // Not merely "not honoured": the string reaches no part of the document at all.
        expect(html, hostile).not.toContain("evil.example");
      }

      // The posted twin. The password is the RIGHT one deliberately — a refusal redirects
      // to /login whatever the callbackURL said, and would pin nothing about `landingOf`.
      for (const hostile of ["https://evil.example/hijack", "/\\evil.example/hijack"]) {
        const answered = await formPost(webPaths.signIn, {
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
    `§13 · a TOTP challenge reached as /login?step=totp&next=/settings/tokens carries redirectTo /settings/tokens, the client's "Use a backup code instead" link built from it is /login?method=backup-code&next=%2Fsettings%2Ftokens, and the island that link opens carries the same landing, as does the way back — with no next= the landing is null, the link is bare and the card it opens lands on /apps (the twin)`,
    async () => {
      const totp = loginIslandOf(
        await anonymousPage(`${paths.login}?step=totp&next=${encodeURIComponent(paths.settingsTokens)}`),
      );
      expect(totp).toEqual({ step: { kind: "totp", error: null }, redirectTo: paths.settingsTokens });
      // The switch link as the client builds it — the encoded spelling the title names.
      const href = webLoginUrl({ method: "backup-code", next: totp.redirectTo });
      expect(href).toBe(`${paths.login}?method=backup-code&next=%2Fsettings%2Ftokens`);

      // Followed as a browser follows it — a document navigation, so the island is the
      // server's again: the card it opens posts the same landing.
      const backup = loginIslandOf(await anonymousPage(href));
      expect(backup).toEqual({ step: { kind: "backup-code", error: null }, redirectTo: paths.settingsTokens });
      // And the way back carries it too, so a round trip between the two cards is lossless.
      const back = loginIslandOf(await anonymousPage(webLoginUrl({ method: "totp", next: backup.redirectTo })));
      expect(back.redirectTo).toBe(paths.settingsTokens);

      // The twin: with no deep link there is nothing to carry, and `loginUrl` drops an
      // empty field rather than spelling it — so the link is bare and the card lands on /apps.
      const bare = loginIslandOf(await anonymousPage(`${paths.login}?step=totp`));
      expect(bare.redirectTo).toBeNull();
      const bareHref = webLoginUrl({ method: "backup-code", next: bare.redirectTo });
      expect(bareHref).toBe(`${paths.login}?method=backup-code`);
      expect(loginIslandOf(await anonymousPage(bareHref)).redirectTo).toBeNull();
    },
  );

  it(
    `§19.5 · a switch made from the signed-authorize arm keeps the /oauth2/authorize landing byte for byte: the TOTP island's redirectTo is the hub's own authorize over the signed query, the client's backup-code link carries it inside next= and never as sig on /login's own query, and the island that link opens carries that same string, sig and client_id intact`,
    async () => {
      const { clientId } = await registerOAuthClient();
      const authorized = await call(new Request(authorizeUrl(clientId)));
      expect(authorized.status).toBe(302);
      const location = authorized.headers.get("Location") ?? "";
      expect(location).toMatch(/^\/login\?/);

      // The challenge card, reached on that same signed query.
      const totp = loginIslandOf(await anonymousPage(`${location}&step=totp`));
      const landing = totp.redirectTo ?? "";
      expect(landing.startsWith(`${paths.auth.base}/oauth2/authorize?`)).toBe(true);
      expect(landing).toContain(`client_id=${clientId}`);
      expect(landing).toContain("sig=");

      const href = webLoginUrl({ method: "backup-code", next: landing });
      // The signed pair rides INSIDE next=, never on /login's own query, which is why the
      // switched URL does not re-trigger the authorize arm and land back on itself.
      expect(new URL(href, ORIGIN).searchParams.has("sig")).toBe(false);

      // One equality is the whole round trip — the client encoded it, `loginIsland` decoded
      // it, and `hubRelative` let it through because it starts "/api/…".
      const backup = loginIslandOf(await anonymousPage(href));
      expect(backup.step.kind).toBe("backup-code");
      expect(backup.redirectTo).toBe(landing);
    },
  );

  // plan row 5, with the 404 on the NO-header side of the twin — a deviation from § Rows,
  // which lists it among the carriers. § Settled puts the header on `render` (web.ts, the
  // tree's only text/html site); every 404 here is `noSuchPage()`, text/plain, built
  // without `render`. On the twin's side the 404 earns its keep: it proves the header
  // rides the page renderer rather than a blanket middleware.
  it(
    `§13 · one renderer emits every HTML page, so every one carries Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" and Cache-Control: no-store — checked on /login's anonymous shell, /apps shelled under the owner's cookie, /apps/new, and the shell at /approvals, /approvals/<id>, /settings, /device and /oauth/consent (decision 38: a page that moved into the client keeps its anti-framing header) — while the hub's non-HTML answers, /styles.css and the surface's 404, carry neither (the twin; no-store added 2026-09-03)`,
    async () => {
      const CSP = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'";
      // Every page family is the shell now (decision 38), so this is every URL a browser
      // can be shown — /login the one among them with no session behind it.
      const carriers = [
        await call(new Request(`${ORIGIN}${paths.login}`)),
        await get(paths.apps),
        await get(paths.appNew),
        await get(paths.approvals),
        await get(paths.approval(world.approvalId)),
        await get(paths.settings),
        await get(`${paths.device}?user_code=${encodeURIComponent("BDWJ-KTQP")}`),
        // The consent shell needs a query the provider really signed.
        (
          await reachConsent((await registerOAuthClient()).clientId, world.session.cookie, {
            resource: oauthResourceFor(world.ns.owner.username),
          })
        ).response,
      ];
      for (const carrier of carriers) {
        expect(carrier.status).toBe(200);
        expect(carrier.headers.get("Content-Type")).toContain("text/html");
        expect(carrier.headers.get("Content-Security-Policy")).toBe(CSP);
        // Every page is a function of the session (or of /login's query): no browser or
        // intermediary may keep a copy to re-show (2026-09-03).
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
    `§4 · ?next=/%09/evil.example, /%0A/evil.example, /%0D/evil.example and /%09%5Cevil.example each leave the #pmcp-login island's redirectTo null, because the rule strips what a browser's URL parser strips before judging — while a hub-relative ?next=/settings/%09tokens reaches it with only the tab gone (/settings/tokens), and a sign-in POST whose callbackURL is /%09/evil.example redirects to /apps (the posted twin)`,
    async () => {
      // Each of these starts "/" and its second character is neither "/" nor "\" — they
      // pass the rule UNSTRIPPED, and are refused only because the strip runs first.
      for (const hostile of ["/\t/evil.example", "/\n/evil.example", "/\r/evil.example", "/\t\\evil.example"]) {
        const html = await anonymousPage(`${paths.login}?next=${encodeURIComponent(hostile)}`);
        expect(loginIslandOf(html).redirectTo, hostile).toBeNull();
        expect(html, hostile).not.toContain("evil.example");
      }

      // The twin: the same three characters inside a landing that stays hub-relative are
      // removed and nothing else is — a strip, not a refusal, and not a pass-through.
      const carried = await anonymousPage(`${paths.login}?next=${encodeURIComponent("/settings/\ttokens")}`);
      expect(loginIslandOf(carried).redirectTo).toBe(paths.settingsTokens);

      // The posted twin, with the tab as the raw character a browser would send. Right
      // password on purpose: a refusal redirects to /login whatever the callbackURL said.
      const answered = await formPost(webPaths.signIn, {
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

/** `GET /api/hub/device` as the SPA asks it (routes §3) — the one call that CLAIMS a
 *  pending code for the reader, as rendering `/device?user_code=` did. `userCode` null
 *  leaves the query off entirely; `cookie` null is the signed-out fetch. */
function deviceRead(userCode: string | null, cookie: string | null = world.session.cookie): Promise<Response> {
  const asked = userCode === null ? "" : `?user_code=${encodeURIComponent(userCode)}`;
  return hub("GET", `/api/hub${deviceApi.read}${asked}`, undefined, { cookie });
}

/** `POST /api/hub/device/decide` as the SPA posts it, with the session's own token unless
 *  the case withholds it (`csrf` null). */
async function deviceDecide(body: unknown, cookie: string = world.session.cookie, csrf?: string | null): Promise<Response> {
  const token = csrf === undefined ? await csrfFor(cookie) : csrf;
  return hub("POST", `/api/hub${deviceApi.decide}`, body, { cookie, ...(token === null ? {} : { csrf: token }) });
}

/** One device code's row as better-auth keeps it — the claim (`userId`) and the verdict
 *  (`status`), which is where "the code stays pending" and "nobody claimed it" are
 *  observable without asking the flow that would change them. */
async function deviceCodeRowOf(userCode: string): Promise<{ status: string; userId: string | null }> {
  const row = await (env.DB as D1Like)
    .prepare(`SELECT "status", "userId" FROM "deviceCode" WHERE "userCode" = ?`)
    .bind(userCode)
    .first<{ status: string; userId: string | null }>();
  if (row === null) throw new Error(`no deviceCode row for ${userCode}`);
  return row;
}

describe("§13 · the device decision, submitted the way the owner submits it", () => {
  // This verdict fronts no op, so no parity walk could ever describe it (§9 rule 4a), and
  // cases 28/29 walk it end to end instead. Both legs run the WHOLE flow — the CLI's code
  // request, the read (which is what CLAIMS the code, as the page render did), the
  // decision, and the CLI's redemption — because the decision is only observable at the
  // far end of it. Ported with decision 38's family 3 from /device's form to the two JSON
  // calls the SPA makes; the confirm card itself — its facts as text, the blast-radius
  // alert — is the client's.

  it("28. §13 · Approve decides the code through the SPA's two calls — the read claims it for the owner and names its client, POST /api/hub/device/decide approve answers `next` exactly /device?decided=approved without a reload — and the CLI's redemption mints a session that /api/whoami answers as the owner", async () => {
    const codes = await requestDeviceCodes();
    const read = await deviceRead(codes.userCode);
    expect(read.status, await read.clone().text()).toBe(200);
    const { request } = (await read.json()) as DeviceRead;
    expect(request.userCode).toBe(codes.userCode);
    // Claimed by THIS read: better-auth names the client to the claimant alone.
    expect(request.client).toBe(DEVICE_CLIENT_ID);

    const { raw, reload } = await redirectedOf(await deviceDecide({ userCode: codes.userCode, decision: "approve" }));
    expect(raw).toBe(`${paths.device}?decided=approved`);
    expect(reload).toBe(false);

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

  it("29. §13 · Deny ends the flow the other way — `next` exactly /device?decided=denied — and the CLI's redemption is refused access_denied with no token (the twin of 28: one read, one gate, two outcomes)", async () => {
    const codes = await requestDeviceCodes();
    expect((await deviceRead(codes.userCode)).status).toBe(200);

    const { raw } = await redirectedOf(await deviceDecide({ userCode: codes.userCode, decision: "deny" }));
    expect(raw).toBe(`${paths.device}?decided=denied`);

    const redeemed = await redeemDeviceCode(codes.deviceCode);
    expect(redeemed.access_token, "a denied code still minted a session").toBeUndefined();
    expect(redeemed.error).toBe("access_denied");
  });

  it("§13 · /device answers the shell behind the ORDINARY owner session — 200, `no-store`, the bootstrap island, the tab title the page drew — and with no cookie it is the 302 to /login carrying the whole deep link, user_code included, as next=, so the CLI's printed URL survives a sign-in", async () => {
    const deepLink = `${paths.device}?user_code=${encodeURIComponent("BDWJ-KTQP")}`;
    const anonymous = await call(new Request(`${ORIGIN}${deepLink}`));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("Location")).toBe(`/login?next=${encodeURIComponent(deepLink)}`);

    // Ordinary, not recent: a day-old session still opens it, as it always did.
    const stale = await seedOwnerSession(world.ns.owner);
    await ageSession(stale.token);
    for (const cookie of [world.session.cookie, stale.cookie]) {
      const answered = await get(deepLink, cookie);
      expect(answered.status).toBe(200);
      expect(answered.headers.get("Cache-Control")).toBe("no-store");
      const html = await answered.text();
      expect(bootstrapCsrfOf(html)).toBe(await csrfFor(cookie));
      expect(html).toContain("<title>Approve device</title>");
    }
  });

  it("§13 · the read answers the confirm card's five facts and nothing else — `{ request }` holding exactly userCode, ip, client, requestedAt, expiresAt; ip the stated ceiling \"unknown\"; expiresAt the window's bound, DEVICE_CODE_TTL_MS after requestedAt — never the device code, the scope or the status better-auth's own verify answer carries", async () => {
    const codes = await requestDeviceCodes();
    const read = await deviceRead(codes.userCode);
    expect(read.status).toBe(200);
    const text = await read.clone().text();
    const body = await jsonOf(read);
    expect(Object.keys(body)).toEqual(["request"]);
    const request = body.request as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual(["client", "expiresAt", "ip", "requestedAt", "userCode"]);
    expect(request.ip).toBe("unknown");
    expect(Date.parse(String(request.expiresAt)) - Date.parse(String(request.requestedAt))).toBe(DEVICE_CODE_TTL_MS);
    // What the verify call returned and the card never showed.
    expect(text, "the read carries the device code").not.toContain(codes.deviceCode);
    expect(text, "the read carries a scope").not.toContain("scope");
    expect(text, "the read carries a status").not.toContain("pending");
  });

  it("§13 · without a session the read is the reader's 401 and claims nothing — the code stays unclaimed — · the owner's own read afterwards claims it and names its client (the twin)", async () => {
    const codes = await requestDeviceCodes();
    const anonymous = await deviceRead(codes.userCode, null);
    expect(anonymous.status).toBe(401);
    expect(await reasonOf(anonymous)).toBe("Sign in again.");
    expect((await deviceCodeRowOf(codes.userCode)).userId, "a signed-out read claimed the code").toBeNull();

    const owned = await deviceRead(codes.userCode);
    expect(owned.status).toBe(200);
    expect(((await owned.json()) as DeviceRead).request.client).toBe(DEVICE_CLIENT_ID);
    expect((await deviceCodeRowOf(codes.userCode)).userId).toBe(world.ns.owner.userId);
  });

  it(`§13 · a code better-auth does not know, and one past its expiry, are the same 404 carrying "That code is not valid. Check it and try again." · a live code is 200 (the twin) — and a read with no user_code, or an empty one, is 400: there is nothing to verify`, async () => {
    const unknown = await deviceRead("ZZZZ-ZZZZ");
    expect(unknown.status).toBe(404);
    const refusal = await unknown.text();
    expect(JSON.parse(refusal)).toEqual({ reason: "That code is not valid. Check it and try again." });

    const expiring = await requestDeviceCodes();
    await (env.DB as D1Like)
      .prepare(`UPDATE "deviceCode" SET "expiresAt" = ? WHERE "userCode" = ?`)
      .bind(new Date(Date.now() - 60_000).toISOString(), expiring.userCode)
      .run();
    const expired = await deviceRead(expiring.userCode);
    expect(expired.status).toBe(404);
    expect(await expired.text()).toBe(refusal);

    const live = await requestDeviceCodes();
    expect((await deviceRead(live.userCode)).status).toBe(200);

    for (const asked of [null, ""]) {
      const missing = await deviceRead(asked);
      expect(missing.status, `user_code ${JSON.stringify(asked)}`).toBe(400);
      expect(await reasonOf(missing)).not.toBe("");
    }
  });

  it("§13 · the read binds a code to its FIRST signed-in reader: a second owner reading a code the first already claimed is not the claimant — client \"unknown\" — and their Approve lands on /device?error=That%20code%20could%20not%20be%20decided. with the code still pending · the claimant's own Approve decides it (the twin)", async () => {
    // routes §3's "Binding, reviewed", made falsifiable: the verify claims a pending
    // unclaimed code for the reader and names the client only to the claimant, and
    // better-auth's approve refuses anyone else. (That the card still OFFERS Approve to a
    // non-claimant is routes §8.3's recorded ceiling, kept exactly.)
    const codes = await requestDeviceCodes();
    expect((await deviceRead(codes.userCode)).status).toBe(200);

    const intruder = await seedOwnerSession((await seedNamespace(env.DB, {})).owner);
    const theirs = await deviceRead(codes.userCode, intruder.cookie);
    expect(theirs.status).toBe(200);
    expect(((await theirs.json()) as DeviceRead).request.client).toBe("unknown");
    const refused = await redirectedOf(await deviceDecide({ userCode: codes.userCode, decision: "approve" }, intruder.cookie));
    expect(refused.raw).toBe(`${paths.device}?error=${encodeURIComponent("That code could not be decided.")}`);
    expect(refused.reload).toBe(false);
    expect(await deviceCodeRowOf(codes.userCode)).toEqual({ status: "pending", userId: world.ns.owner.userId });

    const decided = await redirectedOf(await deviceDecide({ userCode: codes.userCode, decision: "approve" }));
    expect(decided.raw).toBe(`${paths.device}?decided=approved`);
  });

  it("§13 · the decision without `X-Pmcp-Csrf` is 403 and decides nothing — the code stays pending and the CLI's redemption still waits · the same body carrying the session's token decides it (the twin)", async () => {
    // better-auth's own approve gate is origin-only; §13 pins a CSRF check on the verdict,
    // and the write gate's header is that check.
    const codes = await requestDeviceCodes();
    expect((await deviceRead(codes.userCode)).status).toBe(200);

    const refused = await deviceDecide({ userCode: codes.userCode, decision: "approve" }, world.session.cookie, null);
    expect(refused.status).toBe(403);
    expect((await deviceCodeRowOf(codes.userCode)).status).toBe("pending");
    expect((await redeemDeviceCode(codes.deviceCode)).error).toBe("authorization_pending");

    const accepted = await redirectedOf(await deviceDecide({ userCode: codes.userCode, decision: "approve" }));
    expect(accepted.raw).toBe(`${paths.device}?decided=approved`);
    expect((await deviceCodeRowOf(codes.userCode)).status).toBe("approved");
  });

  it("§13 · a decision body that is not `{ userCode: string, decision: \"approve\" | \"deny\" }` is 400 and decides nothing — an unknown verdict is never read as deny or approve — and the old form target POST /device/decide is gone: 404 with no Location, even carrying the session's own CSRF field", async () => {
    const codes = await requestDeviceCodes();
    expect((await deviceRead(codes.userCode)).status).toBe(200);

    for (const body of [
      { userCode: codes.userCode, decision: "maybe" },
      { userCode: codes.userCode },
      { decision: "approve" },
      { userCode: 7, decision: "approve" },
    ]) {
      const refused = await deviceDecide(body);
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }
    // Spelled literally on purpose: this is the path that must no longer route.
    const gone = await post("/device/decide", { user_code: codes.userCode, decision: "approve" }, { csrf: await csrfFor(world.session.cookie) });
    expect(gone.status).toBe(404);
    expect(gone.headers.get("Location")).toBeNull();
    expect((await deviceCodeRowOf(codes.userCode)).status).toBe("pending");
  });
});

describe("§15 · the two auth events the ledger records", () => {
  it("30. §15 · a real sign-in through /login's own form writes exactly one auth.login row, attributed to the user who signed in — and the row carries no body, no token material and nothing the form submitted", async () => {
    // An owner of this case's own, never signed in before: `seedNamespace` provisions the
    // row and `seedOwnerCredential` gives it a password, and neither is a login — so the
    // count below is this sign-in and nothing else.
    const owner = await seedNamespace(env.DB, {});
    await seedOwnerCredential(owner.owner.userId);
    const answered = await formPost(webPaths.signIn, {
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

  it("31. §15 · approving a device through the SPA's own calls — the read, then POST /api/hub/device/decide — writes exactly one auth.device_approved row, attributed to the browser session that approved it — and the row holds neither the codes nor the session it minted", async () => {
    // Ported with decision 38's family 3: the row is written at better-auth's mount
    // (identity.authRoutes), which the JSON verdict reaches exactly as the form did.
    const owner = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(owner.owner);
    const codes = await requestDeviceCodes();
    expect((await deviceRead(codes.userCode, session.cookie)).status).toBe(200);
    await redirectedOf(await deviceDecide({ userCode: codes.userCode, decision: "approve" }, session.cookie));
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
  // IS the browser contract. The shell draws both links at paths.icon192, the row importing
  // paths so the URL is never a literal on this side. Its twin was /login's own head, which
  // linked neither — the ceiling that fix kept. Decision 38's family 5 removed the last page
  // that wrote its own head, so /login is the shell's head too, and the twin became a carrier.
  it(`§13 · the shell head links the icon the worker serves — /apps renders rel="icon" and rel="apple-touch-icon" at paths.icon192 beside the manifest link, and so does /login's anonymous shell, since no page writes its own head any more (decision 38) — the row importing paths while spa.tsx spells the URL itself`, async () => {
    for (const shell of [await page(paths.apps), await anonymousPage(paths.login)]) {
      expect(shell).toContain(`<link rel="manifest" href="${paths.manifest}"`);
      expect(shell).toContain(`<link rel="icon" href="${paths.icon192}"`);
      expect(shell).toContain(`<link rel="apple-touch-icon" href="${paths.icon192}"`);
    }
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
    // The landing both of /login's consumers read — the callbackURL its cards post and the
    // passkey ceremony's navigation — is the island's (decision 38, family 5).
    const landing = loginIslandOf(await anonymousPage(tampered)).redirectTo ?? "";
    expect(landing.startsWith(`${paths.auth.base}/oauth2/authorize?`)).toBe(true);
    expect(landing).toContain(`client_id=${clientId}`);
    expect(landing).not.toContain("/evil");
  });

  // Ported with decision 38's family 4: the screen's strings are `GET /api/hub/oauth/consent`'s
  // now (§19.5 step 3's amendment), read with the client's own signed query appended
  // verbatim — so each row below asks the READ what the screen shows. Drawing them — the name
  // as a text node, the marker beside it, the picker, the empty state, the disabled Allow —
  // is the client's, held by its gallery states.

  it("§19.5 · GET /oauth/consent with a session answers the SPA shell once the provider has verified the signed query — 200, `no-store`, the bootstrap island, and the tab title naming the client — before any HTML the check runs, and the read beside it is the screen's", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "Acme Connector" });
    const { response, html } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(bootstrapCsrfOf(html)).toBe(await csrfFor(world.session.cookie));
    expect(html).toContain("<title>Connect Acme Connector</title>");
  });

  it("§19.5 · the read answers the client's name, the requested scopes, the namespace, and the agent picker's options — every agent in the namespace", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "Acme Connector" });
    const { read } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(read.clientName).toBe("Acme Connector");
    expect(read.scopes).toContain("mcp");
    expect(read.namespace).toBe(world.ns.owner.username);
    const listed = (await ops.agent_list.handler(world.ns.owner.userId, {})) as { agents: { slug: string; name: string }[] };
    expect(read.agents).toEqual(listed.agents.map((agent) => ({ slug: agent.slug, name: agent.name })));
    expect(read.agents.map((agent) => agent.slug)).toContain("agent");
  });

  it("§19.5 · the read names the redirect_uri's ORIGIN — the string that decides where the code goes is shown to the owner, not just the client's self-chosen name", async () => {
    const { clientId } = await registerOAuthClient();
    const { read } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(read.redirectOrigin).toBe(new URL(OAUTH_REDIRECT_URI).origin);
  });

  it('§19.5 · a self-registered (DCR) client reads `clientSelfRegistered: true` — the "registered itself, identity unverified" marker\'s source · a pre-registered client reads false (the twin)', async () => {
    const dcr = await registerOAuthClient({ client_name: "Anon Client" });
    const preRegistered = await registerOAuthClient({ client_name: "Known Client" }, world.session.cookie);
    const resource = oauthResourceFor(world.ns.owner.username);
    expect((await reachConsent(dcr.clientId, world.session.cookie, { resource })).read.clientSelfRegistered).toBe(true);
    expect((await reachConsent(preRegistered.clientId, world.session.cookie, { resource })).read.clientSelfRegistered).toBe(false);
  });

  it("§19.5 · a client name containing markup crosses as a JSON string, byte for byte — the read carries it raw, for the client to render as a text node — and the shell document, whose tab title names the client, never carries it raw: the title is escaped text", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "<script>alert(1)</script>" });
    const { html, read } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(read.clientName).toBe("<script>alert(1)</script>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  // G8 (2026-09-03): the empty state sent the owner to /apps, which cannot create an agent.
  // Ported with family 4: the empty state naming /agents/new and the disabled Allow are the
  // client's to draw; what they are drawn FROM is an empty option list, here.
  it(`§19.5 · a namespace with zero agents reads \`agents: []\` — the first-run path, where the client draws the empty state naming the Agents page and disables Allow, so consent is impossible until an agent exists · the fixture namespace's read lists its agent (the twin)`, async () => {
    const empty = await seedNamespace(env.DB, {});
    const emptySession = await seedOwnerSession(empty.owner);
    const emptyClient = await registerOAuthClient();
    const emptyRead = (
      await reachConsent(emptyClient.clientId, emptySession.cookie, { resource: oauthResourceFor(empty.owner.username) })
    ).read;
    expect(emptyRead.agents).toEqual([]);

    const fullClient = await registerOAuthClient();
    const fullRead = (
      await reachConsent(fullClient.clientId, world.session.cookie, { resource: oauthResourceFor(world.ns.owner.username) })
    ).read;
    expect(fullRead.agents.length).toBeGreaterThan(0);
  });

  it("§19.5 · the read's `oauthQuery` is the consent URL's raw query byte for byte — the value the form posts back is the bytes the provider verified, never one the client assembled", async () => {
    const { clientId } = await registerOAuthClient();
    const { oauthQuery, read } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    expect(read.oauthQuery).toBe(oauthQuery);
  });

  it("§19.5 · the read answers exactly ConsentRead — oauthQuery, clientName, clientSelfRegistered, redirectOrigin, scopes, namespace, agents — and nothing else the screen does not show or echo: no CSRF token, no clock, no client id beyond the signed query", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "Keyset Client" });
    const { oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const answered = await consentReadOf(oauthQuery, world.session.cookie);
    expect(answered.status).toBe(200);
    expect(answered.headers.get("Cache-Control")).toBe("no-store");
    expect(Object.keys(await jsonOf(answered)).sort()).toEqual([
      "agents",
      "clientName",
      "clientSelfRegistered",
      "namespace",
      "oauthQuery",
      "redirectOrigin",
      "scopes",
    ]);
  });

  it("§19.5 · without a session the read is the reader's 401 — it answers nothing to anyone but the owner — while the document for the same query is the 302 to /login carrying it (the row above)", async () => {
    const { clientId } = await registerOAuthClient();
    const { oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const anonymous = await consentReadOf(oauthQuery, null);
    expect(anonymous.status).toBe(401);
    expect(await reasonOf(anonymous)).toBe("Sign in again.");
  });

  it("§19.5 · an EDITED signed query and an EXPIRED one are each refused before any screen exists — the document is the plain 400 (text/plain, no CSP, no no-store) and the read is 400 `{ reason }` — and nothing is written: no binding and no consent at the provider · the untouched query answers both (the twin)", async () => {
    const resource = oauthResourceFor(world.ns.owner.username);
    const { clientId } = await registerOAuthClient();
    const { oauthQuery } = await reachConsent(clientId, world.session.cookie, { resource });
    const edited = new URLSearchParams(oauthQuery);
    edited.set("scope", "mcp offline_access");

    const refusedBoth = async (query: string, name: string): Promise<void> => {
      const document = await get(`${paths.oauthConsent}?${query}`);
      expect(document.status, `${name} document`).toBe(400);
      expect(document.headers.get("Content-Type") ?? "", `${name} document`).toContain("text/plain");
      expect(document.headers.get("Content-Security-Policy"), `${name} document`).toBeNull();
      expect(document.headers.get("Cache-Control"), `${name} document`).toBeNull();
      const read = await consentReadOf(query, world.session.cookie);
      expect(read.status, `${name} read`).toBe(400);
      expect(await reasonOf(read), `${name} read`).toBe("The authorization request could not be verified.");
    };
    await refusedBoth(edited.toString(), "edited");
    // Expired: the provider signs a query good for `codeExpiresIn` (600 s); the clock is
    // moved past it for the two requests alone, which is what an owner who left the screen
    // open would meet.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 11 * 60_000 });
    try {
      await refusedBoth(oauthQuery, "expired");
    } finally {
      vi.useRealTimers();
    }
    expect(await bindingFor(world.ns.owner.userId, clientId)).toBeNull();
    expect(await consentRowExists(world.ns.owner.userId, clientId)).toBe(false);

    // The twin: the same query, unedited and in time.
    expect((await get(`${paths.oauthConsent}?${oauthQuery}`)).status).toBe(200);
    expect((await consentReadOf(oauthQuery, world.session.cookie)).status).toBe(200);
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

    const csrf = bootstrapCsrfOf(html);
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
    const csrf = bootstrapCsrfOf(html);
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
    const csrf = bootstrapCsrfOf(html);
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
    const csrf = bootstrapCsrfOf(html);
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

  it("§19.5 · denying writes no binding and redirects to the client with access_denied — whether the post carries no agent field or the empty one the client's form sends when Deny is pressed with nothing chosen: the agent is read on accept alone, so a deny is never refused for it", async () => {
    // Since decision 38's family 4 the SPA's Deny skips the picker's `required`, so its post
    // carries `agent=""`; since brief §5.3 the agent is resolved before the provider on
    // ACCEPT — which must not turn an empty picker into a refused Deny.
    const variants: Record<string, string>[] = [{}, { agent: "" }];
    for (const fields of variants) {
      const { clientId } = await registerOAuthClient();
      const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
        resource: oauthResourceFor(world.ns.owner.username),
      });
      const csrf = bootstrapCsrfOf(html);
      const denied = await post(paths.oauthConsent, { oauth_query: oauthQuery, decision: "deny", ...fields }, { csrf });
      expect(denied.status, `${JSON.stringify(fields)} → ${await denied.text()}`).toBe(303);
      expect(denied.headers.get("Location")).toContain("error=access_denied");
      expect(await bindingFor(world.ns.owner.userId, clientId)).toBeNull();
    }
  });

  it("§19.5 · a consent POST whose agent does not resolve in this owner's namespace — an invented slug, or another namespace's real agent — is refused 400 and writes NOTHING: no binding and no consent at the provider, so the next authorize still lands on the consent screen instead of the client's redirect · the same signed query naming this owner's own agent then binds and redirects to the client (the twin)", async () => {
    // Brief §5.3's ruling, decided 2026-09-23: the chosen agent is resolved BEFORE the
    // provider's /oauth2/consent is called. Until then a refused agent was refused AFTER the
    // provider had accepted — it kept a consent row with no oauth_binding beside it, the next
    // authorize skipped this screen, and the token that minted was refused at the door until
    // the provider's consent was cleared.
    await seedNamespace(env.DB, { agents: [{ slug: "outsider" }] });
    const resource = oauthResourceFor(world.ns.owner.username);
    for (const agent of [uniqueSlug("nosuchagent"), "outsider"]) {
      const { clientId } = await registerOAuthClient();
      const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, { resource });
      const csrf = bootstrapCsrfOf(html);

      const refused = await post(paths.oauthConsent, { oauth_query: oauthQuery, decision: "accept", agent }, { csrf });
      expect(refused.status, agent).toBe(400);
      expect(refused.headers.get("Location"), agent).toBeNull();
      expect(await bindingFor(world.ns.owner.userId, clientId), agent).toBeNull();
      expect(await consentRowExists(world.ns.owner.userId, clientId), `the provider kept a consent for ${agent}`).toBe(false);
      // The observable half of "no consent": the provider still asks the owner.
      const again = await call(new Request(authorizeUrl(clientId, { resource }), { headers: { Cookie: world.session.cookie } }));
      expect(again.status, agent).toBe(302);
      expect(again.headers.get("Location") ?? "", `the next authorize skipped the screen after ${agent}`).toMatch(
        /^\/oauth\/consent\?/,
      );

      // THE TWIN, on the same client and the same signed query — which the refusal never
      // spent, because the provider was never called.
      const accepted = await post(paths.oauthConsent, { oauth_query: oauthQuery, decision: "accept", agent: "agent" }, { csrf });
      expect(accepted.status, await accepted.clone().text()).toBe(303);
      expect(new URL(accepted.headers.get("Location") ?? "").origin).toBe(new URL(OAUTH_REDIRECT_URI).origin);
      expect((await bindingFor(world.ns.owner.userId, clientId))?.agentId).toBe(world.ns.agents.agent.id);
      expect(await consentRowExists(world.ns.owner.userId, clientId)).toBe(true);
    }
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
    const csrf = bootstrapCsrfOf(html);
    await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "agent" },
      { csrf },
    );
    const binding = await bindingFor(world.ns.owner.userId, clientId);
    expect(binding).not.toBeNull();
    expect(await consentRowExists(world.ns.owner.userId, clientId)).toBe(true);

    // Re-pointed with the pane twice: to /settings/clients (D15), and with decision 38's
    // family 2 to the JSON write that pane's Revoke posts now.
    const before = await query(env.DB, world.ns.owner.userId, { event: "oauth.revoked" });
    await redirectedOf(
      await settingsPost(settingsApi.connectionRevoke, { id: binding?.id ?? "" }, world.session.cookie),
    );

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
  it(`§13 · each of the seven settings panes answers the shell at its own URL — 200, \`no-store\`, the bootstrap island, the tab title the pane drew — · /settings/password is a 404, not an alias and not a redirect (the twin: the seven pane URLs all answer 200)`, async () => {
    for (const pane of PANES) {
      const answered = await get(pane, world.session.cookie);
      expect(answered.status, `GET ${pane}`).toBe(200);
      expect(answered.headers.get("Cache-Control"), `GET ${pane}`).toBe("no-store");
      const html = await answered.text();
      expect(bootstrapCsrfOf(html), `GET ${pane}`).toBe(await csrfFor(world.session.cookie));
      expect(html, `GET ${pane}`).toContain("<title>Settings · personal-mcps</title>");
    }
    // Which pane /settings LANDS on (Password) is the client's route table now; the URL
    // answering at all is this row's.
    // No alias for the landing pane: not a 301, not a 302, not a 303 — nothing to follow.
    const alias = await get(`${paths.settings}/password`);
    expect(alias.status, "GET /settings/password").toBe(404);
    expect(alias.headers.get("Location")).toBeNull();
  });

  // "Every pane renders the same rail" — seven entries under Sign-in, Access and Runtime,
  // Password markerless, aria-current on the pane drawn — retired with decision 38's family
  // 2: the shell draws no rail. The rail is the client's (`SETTINGS_PANES` in
  // web/src/lib/paths.ts, its gallery states and the visual gate against the server
  // baselines); what each marker COUNTS is the next row's, over the read.

  it(`§13 · the one read carries every list a rail marker counts — passkeys, sessions, tokens and connected clients seeded to four different lengths, each list naming exactly the rows its pane lists, so no single number satisfies the rail — and no session row carries its token (§15)`, async () => {
    // Ported with decision 38's family 2: the markers are the client's to draw, and they are
    // the LENGTHS of these four lists (§13's shell rule — one read, never a second query), so
    // what is pinned here is that each list is the right set. Four different lengths on
    // purpose: 2 passkeys, 3 sessions, 4 tokens, 1 client.
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

    const read = await settingsOf(viewer.cookie);
    expect(new Set(read.passkeys.map((row) => row.id))).toEqual(new Set(planted));
    // Two others plus the current one — all three named, so "3" is `2 + 1` counted.
    expect(new Set(read.sessions.map((row) => row.id))).toEqual(
      new Set([await sessionIdOf(first.cookie), await sessionIdOf(second.cookie), await sessionIdOf(viewer.cookie)]),
    );
    const listed = await tokensOf(ns.owner.userId);
    expect(listed.length).toBe(4);
    expect(new Set(read.tokens.map((row) => row.id))).toEqual(new Set(listed.map((row) => row.id)));
    expect(read.connections.map((row) => row.clientId)).toEqual([clientId]);
    expect(read.connections[0].clientName).toBe("Counted Client");

    // §15: the listing the read is built from carries every session's TOKEN; the answer
    // carries none of them — neither a key named `token` nor any token's value.
    const raw = JSON.stringify(read);
    for (const session of [first, second, viewer]) expect(raw).not.toContain(session.token);
    for (const row of read.sessions) expect(Object.keys(row)).not.toContain("token");
  });

  it(`§13 · the Two-factor marker is a status, not a count: the read's \`twoFactor\` says \`{ enabled: false }\` without TOTP and \`{ enabled: true }\` with it · the passkey list beside it is one row in both states (the twin)`, async () => {
    // Ported with family 2: the marker's drawing (a dot, a word) is the client's; the status
    // it draws is this read's, both ways.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    await plantPasskey(ns.owner.userId, { name: "YubiKey 5C" });

    const before = await settingsOf(session.cookie);
    expect(before.twoFactor).toEqual({ enabled: false });
    expect(before.passkeys.length).toBe(1);

    await enrollTwoFactor(ns.owner.userId);
    const after = await settingsOf(session.cookie);
    expect(after.twoFactor).toEqual({ enabled: true });
    expect(after.passkeys.length).toBe(1);
  });
  it(`§4/§13 · the /settings gate is a prefix rule: a stale cookie and a bearer-sourced session are refused on all seven panes, the three ops-backed ones included, and are the same 401 at GET /api/hub/settings — the read every pane draws from (decision 38) · the same seven panes and the read open on a session signed in moments ago (the twin)`, async () => {
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

    // The JSON twin of the same gate: one prefix rule over `/api/hub/settings/*`, so the
    // read answers the two refusals alike — 401, never a 302 a `fetch` could not follow.
    for (const cookie of [stale.cookie, deviceCookie]) {
      const refused = await hub("GET", "/api/hub/settings", undefined, { cookie });
      expect(refused.status).toBe(401);
      expect(await reasonOf(refused)).toBe("Sign in again.");
    }
    expect((await hub("GET", "/api/hub/settings", undefined, { cookie: fresh.cookie })).status).toBe(200);
  });

  it(`§4/§13 · the JSON gate is a PREFIX, not a list: a path under /api/hub/settings/ that no route claims is the same 401 to a stale cookie as a real one — the gate runs before routing, so a route added under the prefix cannot be added ungated · a fresh cookie meets that path's own 404 (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const stale = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    const fresh = await seedOwnerSession(ns.owner);
    const unclaimed = `/api/hub/settings/${uniqueSlug("nowhere")}`;
    for (const method of ["GET", "POST"]) {
      const refused = await hub(method, unclaimed, method === "POST" ? {} : undefined, {
        cookie: stale.cookie,
        csrf: await csrfFor(stale.cookie),
      });
      expect(refused.status, `${method} ${unclaimed} on a day-old cookie`).toBe(401);
      const missing = await hub(method, unclaimed, method === "POST" ? {} : undefined, {
        cookie: fresh.cookie,
        csrf: await csrfFor(fresh.cookie),
      });
      expect(missing.status, `${method} ${unclaimed} on a fresh cookie`).toBe(404);
    }
  });

  it(`§4/§13 · every write under /api/hub/settings/ refuses a day-old cookie and a bearer-sourced session with the same 401, each carrying a real CSRF token so the refusal is the gate's, and reaches neither its op nor better-auth — the passkey still listed, no session ended, the second factor unmoved · the same writes from a fresh session are answered by the target, never by the gate (the twin)`, async () => {
    // Ported with decision 38's family 2 from "every POST target under /settings/": the
    // eleven form targets are gone and the eleven JSON writes stand behind the same recent
    // gate, written once as the prefix rule (the next row proves it IS a prefix).
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent", tokens: [{ as: "agt" }] }],
    });
    const stale = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    const fresh = await seedOwnerSession(ns.owner);
    const other = await seedOwnerSession(ns.owner);
    const passkeyId = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    const { bindingId } = await consentOnce(ns, fresh.cookie, "agent");
    await enrollTwoFactor(ns.owner.userId);
    const writes = settingsWrites({
      passkey: passkeyId,
      session: await sessionIdOf(other.cookie),
      token: (await tokensOf(ns.owner.userId))[0].id,
      connection: bindingId,
    });
    // Each session's OWN token, off a shell it can still open (/apps carries no recency
    // gate), so the refusals below cannot be the CSRF check answering — read out here,
    // because nothing answers once the read handlers are substituted.
    const staleCsrf = await csrfFor(stale.cookie);
    const freshCsrf = await csrfFor(fresh.cookie);
    const bearerCookie = `${fresh.cookie.split("=")[0]}=${await deviceFlowToken(fresh.cookie)}`;
    // The world the refusal legs are judged against, read while it is whole — AFTER the
    // device flow above, which minted a session of its own.
    const before = await settingsOf(fresh.cookie);

    // The refusal legs FIRST and together, so nothing the twin legs change can be mistaken
    // for the gate having let one through.
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const { path, op, body } of writes) {
        for (const [name, cookie] of [
          ["a day-old cookie", stale.cookie],
          ["a device-flow token", bearerCookie],
        ] as const) {
          const refused = await settingsPost(path, body, cookie, staleCsrf);
          expect(refused.status, `POST ${path} on ${name}`).toBe(401);
          expect(await reasonOf(refused), `POST ${path} on ${name}`).toBe("Sign in again.");
        }
        if (op !== null) expect(times(invocations, op), `POST ${path} reached ${op}`).toBe(0);
      }
    });

    // "Never reached better-auth", said about the eight writes that front NO op: `times`
    // counts ops names, so the leg above is 0 === 0 for them by construction and this is
    // what stands in its place. (Update password is measured by `signsIn` in the Password
    // pane's own stale-cookie row: this owner is enrolled in 2FA, so a sign-in here never
    // returns a cookie and the probe would say nothing.)
    const after = await settingsOf(fresh.cookie);
    expect(after.passkeys.map((row) => row.id), "a refused delete-passkey removed it anyway").toEqual(
      before.passkeys.map((row) => row.id),
    );
    expect(new Set(after.sessions.map((row) => row.id)), "a refused revoke ended a session anyway").toEqual(
      new Set(before.sessions.map((row) => row.id)),
    );
    expect(after.twoFactor, "a refused two-factor write moved the second factor anyway").toEqual(before.twoFactor);

    // THE TWIN: the same bodies from a session signed in moments ago, answered by the
    // target rather than by the gate. §4 splits the credential writes by whether they take
    // a password: the four that do must refuse `WRONG_PASSWORD`, the three that take none
    // (remove passkey, revoke session, revoke all others) legitimately succeed, and the
    // TOTP verify refuses a code for an enrolment that is not pending, on its merits.
    const PASSWORD_GUARDED: readonly string[] = [
      settingsApi.totpEnable,
      settingsApi.totpDisable,
      settingsApi.backupCodesGenerate,
      settingsApi.changePassword,
    ];
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const { path, op, body } of writes) {
        const answered = await settingsPost(path, body, fresh.cookie, freshCsrf);
        if (path === settingsApi.totpVerify) {
          expect(answered.status, `POST ${path} on a fresh cookie`).toBe(422);
          continue;
        }
        const { next } = await redirectedOf(answered);
        if (op !== null) {
          expect(times(invocations, op), `POST ${path} reached ${op}`).toBe(1);
          expect(next.searchParams.get("done"), `POST ${path}`).toBe(op);
        } else if (PASSWORD_GUARDED.includes(path)) {
          expect(next.searchParams.get("failed"), `POST ${path} accepted a password that is not the owner's`).not.toBeNull();
        } else {
          expect(next.searchParams.get("done"), `POST ${path}`).not.toBeNull();
        }
      }
    });
    // The Add-passkey ceremony is the one settings credential write this walk cannot see:
    // it rides better-auth's own mount, whose freshness row (below) claims it.
  });

  it(`§13 · a write lands on the pane that drew its control: every settings write's \`next\` names that pane's own URL — never the page root unless the root is the pane — and carries its notice, done= from the ops-backed writes and the credential writes better-auth accepts, failed= from a refused credential (both arms walked)`, async () => {
    // Ported with family 2 from "a mutation posted from a pane redirects back to that
    // pane": `next` IS the Location the 303 named. That the pane then DRAWS the notice —
    // "<Op> done." against "<Op> failed", `noticeOf`'s words — is the client's, over
    // `web/src/lib/notice.ts`.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent", tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const other = await seedOwnerSession(ns.owner);
    const passkeyId = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    const { bindingId } = await consentOnce(ns, session.cookie, "agent");
    await enrollTwoFactor(ns.owner.userId);
    const writes = settingsWrites({
      passkey: passkeyId,
      session: await sessionIdOf(other.cookie),
      token: (await tokensOf(ns.owner.userId))[0].id,
      connection: bindingId,
    });
    // More than one pane, and the root among them, or "never the root" is vacuous.
    const panes = new Set(writes.map((write) => write.pane));
    expect(panes.has(paths.settings)).toBe(true);
    expect([...panes].some((pane) => pane !== paths.settings)).toBe(true);

    const csrf = await csrfFor(session.cookie);
    const flashes: boolean[] = [];
    await withCountedOps([...Object.keys(ops)], async () => {
      for (const { path, pane, body } of writes) {
        // The verify's landing needs a pending enrolment, which the journey rows build.
        if (path === settingsApi.totpVerify) continue;
        const { next } = await redirectedOf(await settingsPost(path, body, session.cookie, csrf));
        expect(next.pathname, `POST ${path} landed off its pane`).toBe(pane);
        const done = next.searchParams.get("done");
        const failed = next.searchParams.get("failed");
        expect(done ?? failed, `POST ${path} carried no notice`).not.toBeNull();
        flashes.push(done !== null);
      }
    });
    expect(flashes.some((done) => done), "no write answered done=").toBe(true);
    expect(flashes.some((done) => !done), "no write answered failed=").toBe(true);
  });

  // "A confirm dialog rides the URL of the pane that owns it" — retired with family 2: the
  // `?confirm=` dialogs are drawn by the client now. The rule is the pure `settingsConfirm`
  // (web/src — a unit row over it, as routes §2 lists), and the owning panes are
  // `SETTINGS_CONFIRM_PANE` in web/src/lib/paths.ts.

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

  // Three rows retired with family 2, each a claim about markup the shell no longer draws:
  //  - "no rendered page links /oauth/consent (the same pages link all seven panes)" — the
  //    pages that link panes are the client's; a walk over the links its routes render is
  //    web-side (routes §2, row 3152), and consent stays chromeless in its own family.
  //  - "the mobile pill row lists the same seven URLs, shortening only Clients" — the pill
  //    row is `SETTINGS_PANES`' `short` column in web/src/lib/paths.ts, drawn by the client.
  //  - "nothing is added TO the consent screen: no rail, no pills" — its twin needed a
  //    server-drawn rail, and none is left; the consent screen's chrome moves to the client
  //    with family 4, where the gallery holds it.

  it(`§4/§13 · an Authorization header with no cookie is refused 401 at an /api/hub/settings write — a credential write and an ops-backed one alike — and reaches neither better-auth nor the op · the identical bodies under the owner's cookie are answered by the target (the twin)`, async () => {
    // Ported with family 2 from the /settings form POSTs, where the same credential was a
    // 302 to /login. Here rather than in auth-matrix, which cannot obtain the CSRF token a
    // shell bootstrapped — and without that token a refusal proves nothing about which gate
    // answered.
    const ns = await seedNamespace(env.DB, { agents: [{ slug: "agent", tokens: [{ as: "agt" }] }] });
    const session = await seedOwnerSession(ns.owner);
    const bearer = await deviceFlowToken(session.cookie);
    const csrf = await csrfFor(session.cookie);
    const tokenId = (await tokensOf(ns.owner.userId))[0].id;

    const legs = [
      {
        path: settingsApi.changePassword,
        // Deliberately wrong, so the twin below cannot move the world it is measured in.
        body: passwordChange({ currentPassword: WRONG_PASSWORD, newPassword: WRONG_PASSWORD }),
        op: "",
      },
      { path: settingsApi.tokenRevoke, body: { id: tokenId }, op: "token_revoke" },
    ];

    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const leg of legs) {
        // The header ALONE — no Cookie — carrying the session's real CSRF token and the
        // hub's Origin, so the only rule that can answer is the session gate's.
        const refused = await call(
          new Request(`${ORIGIN}/api/hub${leg.path}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: ORIGIN,
              Authorization: `Bearer ${bearer}`,
              "X-Pmcp-Csrf": csrf,
            },
            body: JSON.stringify(leg.body),
          }),
        );
        expect(refused.status, `POST ${leg.path} with a bearer and no cookie`).toBe(401);
        expect(sessionCookieOf(refused)).toBeNull();
        if (leg.op !== "") expect(times(invocations, leg.op), `POST ${leg.path}`).toBe(0);
      }
    });

    // Nothing moved — read with the real ops table back, which is also why the counting
    // block above holds only the refusals.
    const untouched = await tokensOf(ns.owner.userId);
    expect(untouched.find((row) => row.id === tokenId)?.revokedAt ?? null).toBeNull();
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    // The twin: the identical bodies under the owner's own cookie and no header.
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const leg of legs) {
        const { next } = await redirectedOf(await settingsPost(leg.path, leg.body, session.cookie, csrf));
        if (leg.op === "") {
          expect(next.searchParams.get("failed"), `POST ${leg.path}`).not.toBeNull();
        } else {
          expect(next.searchParams.get("done"), `POST ${leg.path}`).toBe(leg.op);
          expect(times(invocations, leg.op), `POST ${leg.path}`).toBe(1);
        }
      }
    });
  });
});

describe(`§4/§13 · the Password pane`, () => {
  // Ported with decision 38's family 2: every row posts `POST /api/hub/settings/change-password`
  // — the body the SPA builds — where it posted the pane's form, and reads the refusal's
  // FIELD and the success's `signedOut` off the answer's `next`, which is the Location the
  // 303 named. The SENTENCES a refusal is drawn with ("That password is not right.", "The
  // two entries do not match.", "Password updated." and its two companions) are the client's
  // now, as the pure `passwordErrorOf` and `noticeOf`'s change_password arm (routes §2's view
  // rules, web-side unit rows).

  it(`§13 · the Password pane's one configured number comes from the read: \`limits.passwordMinLength\` is PASSWORD_MIN_LENGTH, the constant better-auth is configured with, beside the two timeout bounds hub_settings_update enforces — so the page holds no second literal of any of them`, async () => {
    // What this row owned about the pane's CONTROLS — the three fields, the default-on box,
    // Update password and the footer sending a forgotten password to the server script — is
    // drawn by the client and held by its gallery states; the body those controls post is
    // `passwordChange`, which every row below sends.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    expect((await settingsOf(session.cookie)).limits).toEqual({
      passwordMinLength: PASSWORD_MIN_LENGTH,
      minTimeoutMs: HUB_MIN_TIMEOUT_MS,
      maxTimeoutMs: HUB_HARD_MAX_TIMEOUT_MS,
    });
  });

  it(`§13/§4 · a new password one character under PASSWORD_MIN_LENGTH is refused: \`next\` lands on the Password pane with failed=change_password and field=newPassword — the length refusal and neither of the other two — no cookie is set and the password already on file still signs in · one of exactly PASSWORD_MIN_LENGTH characters is accepted (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);

    const short = fakePassword(PASSWORD_MIN_LENGTH - 1);
    const refused = await settingsPost(
      settingsApi.changePassword,
      passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: short }),
      session.cookie,
    );
    expect(sessionCookieOf(refused)).toBeNull();
    const { next } = await redirectedOf(refused);
    expect(next.pathname).toBe(paths.settings);
    expect(next.searchParams.get("failed")).toBe("change_password");
    expect(next.searchParams.get("field")).toBe("newPassword");
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, short)).toBe(false);

    // THE TWIN, one character longer — an off-by-one or a second literal fails one leg.
    const exact = fakePassword(PASSWORD_MIN_LENGTH);
    const accepted = await redirectedOf(
      await settingsPost(
        settingsApi.changePassword,
        passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: exact, revokeOtherSessions: false }),
        session.cookie,
      ),
    );
    expect(accepted.next.searchParams.get("done")).toBe("change_password");
    expect(await signsIn(ns.owner.username, exact)).toBe(true);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(false);
  });

  it(`§13 · a wrong current password is refused with field=currentPassword, changes nothing and touches no session — the password already on file still signs in and a bystander session still opens a page · the right one changes it (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const actor = await seedOwnerSession(ns.owner);
    const bystander = await seedOwnerSession(ns.owner);
    const before = await sessionIdOf(actor.cookie);
    const wanted = fakePassword(20);

    const refused = await settingsPost(
      settingsApi.changePassword,
      passwordChange({ currentPassword: WRONG_PASSWORD, newPassword: wanted }),
      actor.cookie,
    );
    expect(sessionCookieOf(refused)).toBeNull();
    const { next } = await redirectedOf(refused);
    expect(next.pathname).toBe(paths.settings);
    expect(next.searchParams.get("failed")).toBe("change_password");
    expect(next.searchParams.get("field")).toBe("currentPassword");
    // "No session is touched", said of a session OTHER than the one posting as well.
    expect(await sessionIdOf(actor.cookie)).toBe(before);
    expect((await get(paths.apps, bystander.cookie)).status).toBe(200);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, wanted)).toBe(false);

    // THE TWIN, one field different — §13's "change is not reset" as the pair it is.
    const accepted = await redirectedOf(
      await settingsPost(
        settingsApi.changePassword,
        passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted, revokeOtherSessions: false }),
        actor.cookie,
      ),
    );
    expect(accepted.next.searchParams.get("done")).toBe("change_password");
    expect(await signsIn(ns.owner.username, wanted)).toBe(true);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(false);
  });

  it(`§13 · new ≠ confirm is the one check the hub makes itself, made before better-auth is called: field=confirmPassword comes back although the current password was right, the session id is unchanged and the password already on file still signs in · the same body with the two entries equal changes it (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const before = await sessionIdOf(session.cookie);
    // Both well inside 12..128, so length cannot refuse, and the current password is
    // RIGHT — so better-auth, whose body schema carries no confirm field, would have
    // succeeded had the hub forwarded. That is the leg a forwarding hub goes red on.
    const typed = fakePassword(20);
    const mistyped = fakePassword(21);

    const refused = await settingsPost(
      settingsApi.changePassword,
      passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: typed, confirmPassword: mistyped }),
      session.cookie,
    );
    expect(sessionCookieOf(refused)).toBeNull();
    const { next } = await redirectedOf(refused);
    expect(next.searchParams.get("failed")).toBe("change_password");
    expect(next.searchParams.get("field")).toBe("confirmPassword");
    expect(await sessionIdOf(session.cookie)).toBe(before);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, typed)).toBe(false);
    expect(await signsIn(ns.owner.username, mistyped)).toBe(false);

    // THE TWIN: the same body with the two entries equal.
    const accepted = await redirectedOf(
      await settingsPost(
        settingsApi.changePassword,
        passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: typed, revokeOtherSessions: false }),
        session.cookie,
      ),
    );
    expect(accepted.next.searchParams.get("done")).toBe("change_password");
    expect(await signsIn(ns.owner.username, typed)).toBe(true);
  });

  it(`§13 · a refusal better-auth answers with a code the pane maps to no field lands with failed= and NO field, changing nothing · a mapped code does carry its field (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // Past better-auth's own ceiling — a length the hub knows nothing about, so reaching a
    // refusal at all is evidence better-auth's own validation ran. Spelled as a length.
    const enormous = fakePassword(200);

    const unmapped = await settingsPost(
      settingsApi.changePassword,
      passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: enormous }),
      session.cookie,
    );
    expect(sessionCookieOf(unmapped)).toBeNull();
    const { next } = await redirectedOf(unmapped);
    expect(next.pathname).toBe(paths.settings);
    expect(next.searchParams.get("failed")).toBe("change_password");
    // §13's "Anything else is the ordinary refusal notice": no control named.
    expect(next.searchParams.get("field")).toBeNull();
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    // THE TWIN: a MAPPED code also answers `failed=`, and is distinguishable.
    const legal = fakePassword(20);
    const mapped = await redirectedOf(
      await settingsPost(
        settingsApi.changePassword,
        passwordChange({ currentPassword: WRONG_PASSWORD, newPassword: legal }),
        session.cookie,
      ),
    );
    expect(mapped.next.searchParams.get("failed")).toBe("change_password");
    expect(mapped.next.searchParams.get("field")).toBe("currentPassword");
  });

  it(`§13 · the pane reports the gate's own clock: the read's current session carries the createdAt the recent-auth gate reads, so a session created a known number of minutes ago reads that many minutes, and a session of a different age reads a different number`, async () => {
    // Ported with family 2: "Confirmed your identity N minutes ago." is the client's
    // sentence over this value — the row pins that the value IS the gate's clock.
    const ns = await seedNamespace(env.DB, {});
    const a = await seedOwnerSession(ns.owner);
    const b = await seedOwnerSession(ns.owner);
    // EXACT minute multiples, both well inside `freshAge`, so the read's own 200 is the
    // check that these ages are the gate's `createdAt` and not an expiry.
    await ageSession(a.token, 7 * 60_000);
    await ageSession(b.token, 20 * 60_000);
    const minutesOf = async (cookie: string): Promise<number> => {
      const current = (await settingsOf(cookie)).sessions.filter((row) => row.current);
      expect(current.length, "the read marked no single session current").toBe(1);
      return Math.floor((Date.now() - Date.parse(current[0].createdAt)) / 60_000);
    };
    expect(await minutesOf(a.cookie)).toBe(7);
    expect(await minutesOf(b.cookie)).toBe(20);
  });

  it(`§13 · Update password with Sign out my other sessions ticked walks end to end: \`next\` is the Password pane with done=change_password and signedOut=2, the answer forwards better-auth's Set-Cookie and says reload, that cookie names a session that is not the one that posted, the old cookie and the other browser session are sent to /login, the CLI's bearer is dead, and the read afterwards lists one session`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const { actor, bystander, device, before, otherId } = await threeSessions(ns);
    // The before-leg that makes the after-leg's absence non-vacuous.
    expect((await settingsOf(actor.cookie)).sessions.map((row) => row.id)).toContain(otherId);

    const wanted = fakePassword(20);
    const answered = await settingsPost(
      settingsApi.changePassword,
      passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted }),
      actor.cookie,
    );
    // §13's "this one stays" is true from the owner's chair and false at the row level:
    // the id changes and the cookie is REPLACED in the same response — which is why the
    // answer says `reload`: the CSRF token the document holds died with the old session.
    const fresh = sessionCookieOf(answered);
    expect(fresh).not.toBeNull();
    const { next, reload } = await redirectedOf(answered);
    expect(reload).toBe(true);
    expect(next.pathname).toBe(paths.settings);
    expect(next.searchParams.get("done")).toBe("change_password");
    expect(next.searchParams.get("signedOut")).toBe("2");
    expect(await sessionIdOf(fresh ?? "")).not.toBe(before);

    // Every other way in is gone — the browser's old cookie, the other browser, the CLI.
    // The destination, not just the status: a redirect anywhere else is not "signed out".
    for (const dead of [actor.cookie, bystander.cookie]) {
      const bounced = await get(paths.settings, dead);
      expect(bounced.status).toBe(302);
      expect(bounced.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);
    }
    expect((await whoami(device)).status).toBe(401);
    expect((await get(paths.settings, fresh ?? "")).status).toBe(200);

    // §13's "shows one session created just now".
    const after = (await settingsOf(fresh ?? "")).sessions;
    expect(after.length).toBe(1);
    expect(after.map((row) => row.id)).not.toContain(before);
    expect(after.map((row) => row.id)).not.toContain(otherId);
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
    const { next } = await redirectedOf(
      await settingsPost(
        settingsApi.changePassword,
        passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted }),
        session.cookie,
      ),
    );
    expect(next.searchParams.get("done")).toBe("change_password");

    const afterAgent = await whoami(ns.tokens.agent.token);
    expect(afterAgent.status).toBe(200);
    expect(await afterAgent.json()).toMatchObject({ principal: `agent:${agent}` });
    expect(await resolveAppToken(appRequest())).toMatchObject({ appId: ns.apps[slug].id });
  });

  it(`§13 · unticking Sign out my other sessions is the whole difference: the change succeeds with no signedOut in \`next\`, this session's id is unchanged, and the other sessions still open pages (the twin of the flag)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    // Built exactly as the ticked row builds them, so the two rows differ in ONE thing.
    const { actor, bystander, device, before } = await threeSessions(ns);

    const wanted = fakePassword(20);
    const { next } = await redirectedOf(
      await settingsPost(
        settingsApi.changePassword,
        passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted, revokeOtherSessions: false }),
        actor.cookie,
      ),
    );
    expect(next.pathname).toBe(paths.settings);
    expect(next.searchParams.get("done")).toBe("change_password");
    // Non-vacuous because the ticked row next door carries exactly this key.
    expect(next.searchParams.get("signedOut")).toBeNull();

    expect(await sessionIdOf(actor.cookie)).toBe(before);
    expect((await get(paths.apps, bystander.cookie)).status).toBe(200);
    expect((await whoami(device)).status).toBe(200);
    expect(await signsIn(ns.owner.username, wanted)).toBe(true);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(false);
  });

  it(`§13 · POST /api/hub/settings/change-password without the X-Pmcp-Csrf header is 403 and the password is untouched — the old one still signs in · the same body carrying it changes the password (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const before = await sessionIdOf(session.cookie);
    const wanted = fakePassword(20);
    const body = passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted, revokeOtherSessions: false });

    // The shape of a cross-site request: everything the SPA sends EXCEPT its token.
    const refused = await settingsPost(settingsApi.changePassword, body, session.cookie, null);
    expect(refused.status).toBe(403);
    expect(sessionCookieOf(refused)).toBeNull();
    expect(await sessionIdOf(session.cookie)).toBe(before);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
    expect(await signsIn(ns.owner.username, wanted)).toBe(false);

    // THE TWIN, without which a `throw 403` on the whole route would pass.
    const accepted = await redirectedOf(await settingsPost(settingsApi.changePassword, body, session.cookie));
    expect(accepted.next.searchParams.get("done")).toBe("change_password");
    expect(await signsIn(ns.owner.username, wanted)).toBe(true);
  });

  it(`§4/§13 · POST /api/hub/settings/change-password with no credential at all — no cookie, no bearer — is 401 and the password is untouched · the same body under the owner's own fresh cookie reaches better-auth (the twin)`, async () => {
    // The SESSION third of §13's "session, recent authentication, CSRF" — the one a gate
    // that checked only recency would slip through.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const csrf = await csrfFor(session.cookie);
    const body = passwordChange({
      currentPassword: SEEDED_OWNER_PASSWORD,
      newPassword: fakePassword(20),
      revokeOtherSessions: false,
    });

    const anonymous = await hub("POST", `/api/hub${settingsApi.changePassword}`, body, { cookie: null, csrf });
    expect(anonymous.status).toBe(401);
    expect(sessionCookieOf(anonymous)).toBeNull();
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);

    const accepted = await redirectedOf(await settingsPost(settingsApi.changePassword, body, session.cookie, csrf));
    expect(accepted.next.pathname).toBe(paths.settings);
  });

  it(`§4 · decision 39 · a day-old cookie is refused at both doors to a password change: straight at /api/auth/change-password it meets the mount's freshness guard (403 SESSION_NOT_FRESH, password untouched), and at POST /api/hub/settings/change-password the hub's recent-auth gate never lets it reach better-auth`, async () => {
    // Both doors refuse the same stale session.
    // One app, because /apps is where a session with no recency left can still read its
    // own CSRF token and a namespace with no rows draws no form to read one off.
    const ns = await seedNamespace(env.DB, { apps: [{ slug: uniqueSlug("pwgate"), kind: "tunnel" }] });
    const stale = await seedOwnerSession(ns.owner);
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

    // LEG B: the same cookie at the hub's own write (decision 38 moved it from the
    // /settings/change-password form, where the same refusal was a 302), carrying its own
    // real CSRF token — read off /apps, which has no recency gate — so the refusal is the
    // prefix gate's, before better-auth is ever called.
    const gated = await settingsPost(
      settingsApi.changePassword,
      passwordChange({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted, revokeOtherSessions: false }),
      stale.cookie,
    );
    expect(gated.status).toBe(401);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
  });

  it(`§4 · the day-old cookie that can post none of the settings credential writes cannot post Update password either — refused 401, walked stale and fresh · a session signed in moments ago reaches better-auth with the same body (the twin)`, async () => {
    // /apps is where a stale session can still read its own CSRF token: the shell document
    // carries it in the bootstrap island behind no recency gate, whatever the namespace
    // holds. An app is seeded anyway, so the namespace is the one the gate walk's is.
    const ns = await seedNamespace(env.DB, { apps: [{ slug: uniqueSlug("pwstale"), kind: "tunnel" }] });
    const stale = await seedOwnerSession(ns.owner);
    const fresh = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    // A deliberately WRONG current password throughout, so neither leg's success can move
    // the other's world and the two legs differ in exactly one thing: whose cookie.
    const body = passwordChange({ currentPassword: WRONG_PASSWORD, newPassword: fakePassword(20), revokeOtherSessions: false });

    // Each session's own real CSRF token, so the refusal cannot be the CSRF check.
    const refused = await settingsPost(settingsApi.changePassword, body, stale.cookie);
    expect(refused.status).toBe(401);
    expect(await reasonOf(refused)).toBe("Sign in again.");

    const reached = await redirectedOf(await settingsPost(settingsApi.changePassword, body, fresh.cookie));
    expect(reached.next.pathname).toBe(paths.settings);
    expect(reached.next.searchParams.get("failed")).toBe("change_password");
  });
});

describe(`§13 · the Two-factor, Passkeys and Sessions panes`, () => {
  // Ported with decision 38's family 2: each row's server fact is read off
  // `GET /api/hub/settings`'s `passkeys` and `sessions` rows, and each journey posts its
  // `/api/hub/settings/*` write. How a row is DRAWN — "Added <date>", the "· device flow"
  // suffix, the current badge, the empty-state sentence, the Remove/Revoke dialogs — is the
  // client's, over `format.ts` and its gallery states.

  // plan row 8, and the replacement for the row retired with it — that one was green on
  // data the ceremony never produces: a stored name and no aaguid. What the pane owes is
  // the authenticator's own report — a known AAGUID reading "Windows Hello", the all-zero
  // one privacy-preserving platforms send reading "Passkey" — with the empty list the twin.
  it(
    `§13 · the read names a passkey the way the authenticator reported it: a passkey stored with a known AAGUID and no name reads "Windows Hello", one with the all-zero AAGUID that privacy-preserving platforms report reads "Passkey", and the list is those two · with none, the list is empty (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      // The twin first, before anything is planted. Its sentence ("No passkeys yet. Add
      // one to sign in without a password.") is the client's empty state.
      expect((await settingsOf(session.cookie)).passkeys).toEqual([]);

      // Exactly what a registration writes: an AAGUID and no name at all (the Add-passkey
      // ceremony sends none). One model the plugin's own table knows, and the all-zero value.
      const known = await plantPasskey(ns.owner.userId, { aaguid: "08987058-cadc-4b81-b6e1-30de50dcbe96" });
      const anonymous = await plantPasskey(ns.owner.userId, { aaguid: "00000000-0000-0000-0000-000000000000" });

      const names = new Map((await settingsOf(session.cookie)).passkeys.map((row) => [row.id, row.name]));
      expect(names).toEqual(
        new Map([
          [known, "Windows Hello"],
          [anonymous, "Passkey"],
        ]),
      );
    },
  );

  // plan row 7. The device flow mints the one client no browser can — so the row reads both
  // sessions off a single read: the CLI's row beside the browser session's own.
  it(
    `§13 · a session minted by the device flow is a \`source: "cli"\` row whose client is "pmcp CLI", beside the browser session that asked, a \`source: "web"\` row reading its own client — "Unknown client", since it sent no User-Agent — and never the CLI's (the twin); the list is those two`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const browser = await seedOwnerSession(ns.owner);
      // The whole RFC 8628 walk, because /device/token is the one endpoint that stamps the
      // column — a row planted by hand would be the test asserting its own setup.
      await deviceFlowToken(browser.cookie);

      const sessions = (await settingsOf(browser.cookie)).sessions;
      expect(sessions.length).toBe(2);
      const cli = sessions.filter((row) => row.source === "cli");
      const web = sessions.filter((row) => row.source === "web");
      expect(cli.map((row) => row.client)).toEqual(["pmcp CLI"]);
      // The twin, on the same read: a `source` stamped from a header would make the browser
      // claim the CLI's label; the column decides.
      expect(web.map((row) => [row.client, row.current])).toEqual([["Unknown client", true]]);
    },
  );

  it(`§13 · each passkey row carries its own added stamp: two passkeys with the same name and different createdAt are two rows whose addedAt is each one's own`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // Same name, different stamps: everything about these rows except the stamp is equal,
    // so a loader that dropped it — or stamped the read instant, which is what a null
    // `createdAt` produces — answers one row twice.
    const older = await plantPasskey(ns.owner.userId, { name: "YubiKey 5C", createdAt: "2026-01-08T17:40:00.000Z" });
    const newer = await plantPasskey(ns.owner.userId, { name: "YubiKey 5C", createdAt: "2026-03-12T09:14:00.000Z" });

    const added = new Map((await settingsOf(session.cookie)).passkeys.map((row) => [row.id, row.addedAt]));
    expect(added).toEqual(
      new Map([
        [older, "2026-01-08T17:40:00.000Z"],
        [newer, "2026-03-12T09:14:00.000Z"],
      ]),
    );
  });

  it(`§5/§13 · identity.stampPasskeyUse writes §5's last_used_at for the credential id it names — and only that one — and the read's row carries it as lastUsedAt only after it: before the stamp no passkey has one (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const credA = uniqueSlug("creda");
    const credB = uniqueSlug("credb");
    const rowA = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID", credentialId: credA });
    const rowB = await plantPasskey(ns.owner.userId, { name: "YubiKey 5C", credentialId: credB });

    // LEG ONE, the twin that keeps leg two non-vacuous: neither row has ever been used.
    expect((await settingsOf(session.cookie)).passkeys.map((row) => row.lastUsedAt)).toEqual([null, null]);

    // An INJECTED clock, so the value written is known rather than merely non-null.
    const AT = 1_760_000_000_000;
    await stampPasskeyUse(credA, () => AT);
    expect(await lastUsedOf(credA)).toBe(AT);
    // Keyed by the credential the assertion named, not by the user who owns both.
    expect(await lastUsedOf(credB)).toBeNull();

    // LEG TWO: §5's own column, which is what proves the read reads the hub's column.
    const lastUsed = new Map((await settingsOf(session.cookie)).passkeys.map((row) => [row.id, row.lastUsedAt]));
    expect(lastUsed).toEqual(
      new Map([
        [rowA, new Date(AT).toISOString()],
        [rowB, null],
      ]),
    );
  });

  it(`§13 · Remove passkey walks end to end: POST /api/hub/settings/passkey/delete-passkey with the row's id answers \`next\` on /settings/passkeys with done=passkey_remove, and the read lists it no more · an id naming no passkey lands failed= and removes nothing (the twin)`, async () => {
    // Its own namespace and session: the list below is compared whole.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const id = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    expect((await settingsOf(session.cookie)).passkeys.map((row) => row.id)).toEqual([id]);

    // The twin FIRST, so the removal below is what empties the list. (A guessed id drawing
    // no DIALOG is the client's `settingsConfirm`; the server's half is refusing to act.)
    const guessed = await redirectedOf(
      await settingsPost(settingsApi.passkeyDelete, { id: uniqueSlug("nope") }, session.cookie),
    );
    expect(guessed.next.pathname).toBe(paths.settingsPasskeys);
    expect(guessed.next.searchParams.get("failed")).toBe("passkey_remove");
    expect((await settingsOf(session.cookie)).passkeys.map((row) => row.id)).toEqual([id]);

    const { next } = await redirectedOf(await settingsPost(settingsApi.passkeyDelete, { id }, session.cookie));
    expect(next.pathname).toBe(paths.settingsPasskeys);
    expect(next.searchParams.get("done")).toBe("passkey_remove");
    expect((await settingsOf(session.cookie)).passkeys).toEqual([]);
  });

  // "Add passkey is the one credential control that is not a form: /settings/passkeys names
  // better-auth's register endpoints in a script calling navigator.credentials.create" —
  // retired with family 2: the pane is the client's, and its ceremony is a module of the
  // bundle, not an inline script the worker renders (routes §2, rows 3996/4035: web-side).
  // Its SERVER half stays below: the two register endpoints refuse a day-old cookie with
  // better-auth's own SESSION_NOT_FRESH.

  // "/login's passkey button is live the same way — the page names generate-authenticate-
  // options and verify-authentication in a script calling navigator.credentials.get" — the
  // drawing half retired with family 5: the ceremony is a module of the bundle, not an
  // inline script the worker renders (routes §5, row 4035: web-side). What stays is the seam
  // between the two path tables, which no gallery state can see.
  it(`§13 · /login's passkey ceremony calls the two authentication endpoints better-auth mounts — the SPA's path table names exactly paths.auth's generate-authenticate-options and verify-authentication — while its username form still posts to the hub's translation route, never at better-auth's mount (the twin)`, async () => {
    expect({ ...passkeyAuthentication }).toEqual({
      options: paths.auth.passkeyAuthenticateOptions,
      verify: paths.auth.passkeyVerifyAuthentication,
    });
    // The twin: the credential card is still a form, posted at the hub.
    expect(webPaths.signIn).toBe(paths.auth.signIn);
    expect(webPaths.signIn.startsWith(paths.auth.base)).toBe(false);
  });

  it(`§13 · the read lists every session of the owner — the viewer's own marked current and no other — and each row carries the Client / Created / Last active facts the pane's columns draw`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const a = await seedOwnerSession(ns.owner);
    const b = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const [aId, bId, viewerId] = [await sessionIdOf(a.cookie), await sessionIdOf(b.cookie), await sessionIdOf(viewer.cookie)];

    const sessions = (await settingsOf(viewer.cookie)).sessions;
    expect(new Map(sessions.map((row) => [row.id, row.current]))).toEqual(
      new Map([
        [aId, false],
        [bId, false],
        [viewerId, true],
      ]),
    );
    // The column names are the client's; the facts under them are these fields.
    for (const row of sessions) {
      expect(typeof row.client).toBe("string");
      expect(Number.isNaN(Date.parse(row.createdAt)), `${row.id} createdAt`).toBe(false);
      expect(Number.isNaN(Date.parse(row.lastActiveAt)), `${row.id} lastActiveAt`).toBe(false);
    }
  });

  // The owner's live pane read "Unknown client" on every browser row (2026-09-03): /login's
  // translation rebuilt the request with only the cookie, so better-auth stored "" as the
  // session's User-Agent and nothing was left to name. The fix is on both sides of that
  // seam — identity forwards the header, model reads a label out of it — and this row
  // walks the whole seam as a browser does: three form sign-ins, one read.
  it(`§13 · the Client column names the browser and system a web session was signed in from — /login's translation forwards the browser's User-Agent to better-auth, so a Chrome-on-Windows sign-in through the form reads "Chrome on Windows" and a Safari-on-iPhone one "Safari on iPhone", never the raw string · a sign-in that sent no User-Agent reads "Unknown client" (the twin)`, async () => {
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

    // Chrome's string also says "Safari" and "Mac OS X" is in the iPhone's: the labels are
    // what the lists picked, so a parse that took the first or last token would read
    // something else here.
    const clients = (await settingsOf(chrome)).sessions.map((row) => row.client).sort();
    expect(clients).toEqual(["Chrome on Windows", "Safari on iPhone", "Unknown client"]);
  });

  it(`§13 · the session asking is the read's one \`current\` row — the row the client badges and never offers a Revoke on — while every other session of the owner is \`current: false\` (the twin)`, async () => {
    // Ported with family 2. "No link on its row, and its own ?confirm=revoke-session draws no
    // dialog" is the client's drawing of this one field (`settingsConfirm`, web-side).
    const ns = await seedNamespace(env.DB, {});
    const other = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const [currentId, otherId] = [await sessionIdOf(viewer.cookie), await sessionIdOf(other.cookie)];

    const sessions = (await settingsOf(viewer.cookie)).sessions;
    expect(sessions.filter((row) => row.current).map((row) => row.id)).toEqual([currentId]);
    expect(sessions.find((row) => row.id === otherId)?.current).toBe(false);
    // And the same owner asking from the OTHER session sees the flag move with it.
    expect((await settingsOf(other.cookie)).sessions.filter((row) => row.current).map((row) => row.id)).toEqual([
      otherId,
    ]);
  });

  it(`§4/§13 · Revoke walks end to end: POST /api/hub/settings/revoke-session with a listed session's id answers \`next\` on /settings/sessions with done=session_revoke, the session is gone from the read — one row fewer — and its cookie opens nothing, while the current one still does`, async () => {
    const doomed = await seedOwnerSession(world.ns.owner);
    // Resolved BEFORE the revoke: afterwards the cookie names no session, which is the
    // postcondition rather than a way to ask for the id.
    const doomedId = await sessionIdOf(doomed.cookie);
    const before = (await settingsOf(world.session.cookie)).sessions;
    expect(before.map((row) => row.id)).toContain(doomedId);

    const { next } = await redirectedOf(
      await settingsPost(settingsApi.sessionRevoke, { id: doomedId }, world.session.cookie),
    );
    // The flash says which it was, so a refusal fails HERE with its reason rather than
    // three lines later as an unexplained listing.
    expect(next.pathname).toBe(paths.settingsSessions);
    expect(next.searchParams.get("done")).toBe("session_revoke");

    const after = (await settingsOf(world.session.cookie)).sessions;
    expect(after.map((row) => row.id)).not.toContain(doomedId);
    expect(after.length).toBe(before.length - 1);
    expect(after.some((row) => row.current)).toBe(true);
    expect((await get(paths.settingsSessions, doomed.cookie)).status).toBe(302);
  });

  it(`§13 · Revoke all others walks end to end through better-auth's /revoke-other-sessions: every other session is gone and its cookie opens nothing, while the CURRENT session's id is unchanged, its cookie unreplaced — so the answer does not say reload — and still opening the pane: the opposite contract from the Password pane's flag, which replaces it`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const a = await seedOwnerSession(ns.owner);
    const b = await seedOwnerSession(ns.owner);
    const viewer = await seedOwnerSession(ns.owner);
    const [aId, bId, viewerId] = [
      await sessionIdOf(a.cookie),
      await sessionIdOf(b.cookie),
      await sessionIdOf(viewer.cookie),
    ];
    expect((await settingsOf(viewer.cookie)).sessions.length).toBe(3);

    const answered = await settingsPost(settingsApi.revokeOtherSessions, {}, viewer.cookie);
    // THE CONTRAST with the Password pane's checkbox, three ways. (1) This session is not
    // replaced — stated as "never a cookie naming a different session", so a same-token
    // refresh cookie cannot fail the row for the wrong reason.
    const replacement = sessionCookieOf(answered);
    if (replacement !== null) expect(replacement).toBe(viewer.cookie);
    const { next } = await redirectedOf(answered);
    expect(next.pathname).toBe(paths.settingsSessions);
    expect(next.searchParams.get("done")).toBe("revoke_other_sessions");
    // (2) its id is unchanged, and (3) it still opens the pane.
    expect(await sessionIdOf(viewer.cookie)).toBe(viewerId);
    expect((await get(paths.settingsSessions, viewer.cookie)).status).toBe(200);

    const after = (await settingsOf(viewer.cookie)).sessions.map((row) => row.id);
    expect(after).toEqual([viewerId]);
    for (const id of [aId, bId]) expect(after).not.toContain(id);
    expect((await get(paths.settingsSessions, a.cookie)).status).toBe(302);
    expect((await get(paths.settingsSessions, b.cookie)).status).toBe(302);
  });

  it(`§13 · a CLI session is listed and revocable: after a device flow the read carries one more row, and revoking that row through POST /api/hub/settings/revoke-session kills the CLI's bearer while the browser session still opens the pane (the twin)`, async () => {
    // §13 says "every web and CLI session", and the rows above prove the universal over
    // browser sessions alone.
    const ns = await seedNamespace(env.DB, {});
    const viewer = await seedOwnerSession(ns.owner);
    const before = new Set((await settingsOf(viewer.cookie)).sessions.map((row) => row.id));
    expect(before.size).toBe(1);

    // The real RFC 8628 exchange, which mints a real session row for this owner.
    const token = await deviceFlowToken(viewer.cookie);
    const added = (await settingsOf(viewer.cookie)).sessions.filter((row) => !before.has(row.id));
    expect(added.map((row) => row.source), "the device flow added no single CLI row").toEqual(["cli"]);
    // The PRINCIPAL, not just the status (case 28's own call): a bearer that authenticated
    // as somebody else would otherwise satisfy the pre-revoke leg.
    const answeredWhoami = await whoami(token);
    expect(answeredWhoami.status).toBe(200);
    expect(await answeredWhoami.json()).toMatchObject({ principal: `user:${ns.owner.username}` });

    const { next } = await redirectedOf(
      await settingsPost(settingsApi.sessionRevoke, { id: added[0].id }, viewer.cookie),
    );
    expect(next.searchParams.get("done")).toBe("session_revoke");
    expect((await whoami(token)).status).toBe(401);
    // The twin: revoking the CLI's row took the CLI's session and nothing else.
    expect((await get(paths.settingsSessions, viewer.cookie)).status).toBe(200);
  });

  // "/settings/two-factor is the Two-factor pane's one URL: it renders the card, its forms
  // post to the paths.auth targets, and its Disable confirm rides /settings/two-factor" —
  // retired with family 2. The URL answering the shell is the shell describe's first row;
  // the card, its controls and its Disable dialog are the client's; and where each write
  // lands is the "a write lands on the pane that drew its control" row.

  it(`§9/§13 · every settings write is claimed: the eleven writes are the credential routes routes §2 designs plus exactly one route per ops-backed pane — each of the eight credential writes reaches no op at all (§13's pinned exception), token_revoke is reached only by the Tokens write, connection_revoke only by the Clients write and hub_settings_update only by the Execution write — so no generic dispatcher survives under /api/hub/settings`, async () => {
    // Ported with family 2 from "every control the /settings panes render is claimed". The
    // CONTROL walk — which pane draws which form, the confirm links riding their panes, Add
    // passkey as the one enumerated exclusion — is the client's; the ROUTE set is here.
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const csrf = await csrfFor(session.cookie);
    const writes = settingsWrites();
    // Exactly three ops-backed writes, each naming a DIFFERENT op.
    expect(writes.filter((write) => write.op !== null).map((write) => write.op).sort()).toEqual([
      "connection_revoke",
      "hub_settings_update",
      "token_revoke",
    ]);

    for (const { path, op, body } of writes) {
      await withCountedOps([...Object.keys(ops)], async (invocations) => {
        const answered = await settingsPost(path, body, session.cookie, csrf);
        expect([200, 422], `POST ${path} → ${answered.status}`).toContain(answered.status);
        const reached = [...invocations.keys()].filter((name) => times(invocations, name) > 0);
        expect(reached, `POST ${path} fronts ${reached.join(", ") || "no op"}`).toEqual(op === null ? [] : [op]);
      });
    }

    // And a generic op name under either ops-backed pane is not a route: `token_issue`
    // under Tokens, `app_delete` under Clients — the two dispatchers this replaced admitted
    // both by name.
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const path of ["/api/hub/settings/tokens/token_issue", "/api/hub/settings/clients/app_delete"]) {
        const answered = await hub("POST", path, { slug: "news", kind: "app" }, { cookie: session.cookie, csrf });
        expect(answered.status, `POST ${path}`).toBe(404);
      }
      expect([...invocations.keys()].filter((name) => times(invocations, name) > 0)).toEqual([]);
    });
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
  // Ported with decision 38's family 2. The journey still has ONE entrance: the read never
  // carries an enrolment (nothing answers one but Enable), so every row below starts by
  // posting Enable and reading the 200 that answers with it. The CARD — the QR drawn, the
  // grouped line, the six boxes, the codes and their Copy control, the refusal redrawn under
  // the boxes — is the client's now, drawn from that body and held in its gallery states;
  // what the server owes is the body itself, and that no secret ever reaches a URL.

  /** Enable, as the SPA posts it — the owner's own password. The whole Response is handed
   *  back rather than its body, because "carries no Location" is one of the claims. */
  function enable(cookie: string): Promise<Response> {
    return settingsPost(settingsApi.totpEnable, { password: SEEDED_OWNER_PASSWORD }, cookie);
  }

  /** The reveal Enable answers with (routes §2): the enrolment and the ten codes, and
   *  nothing else — a body with a third key is a body something extra could ride. */
  async function enrolmentOf(response: Response): Promise<{
    enrollment: { totpUri: string; qrDataUri: string; secret: string; error: string | null };
    backupCodes: string[];
  }> {
    expect(response.status, await response.clone().text()).toBe(200);
    const body = await jsonOf(response);
    expect(Object.keys(body).sort()).toEqual(["backupCodes", "enrollment"]);
    return body as Awaited<ReturnType<typeof enrolmentOf>>;
  }

  /** The `secret` parameter of one enrolment's own otpauth URI — better-auth's unpadded
   *  base32, which is both what the QR encodes and what an authenticator is typed. */
  function secretOf(totpUri: string): string {
    const uri = new URL(totpUri);
    expect(uri.protocol, "the enrolment carries no otpauth URI").toBe("otpauth:");
    expect(uri.host).toBe("totp");
    const secret = uri.searchParams.get("secret") ?? "";
    expect(secret, "the otpauth URI names no secret").not.toBe("");
    return secret;
  }

  // plan row 1. The body is the minted secret's one carrier, so the row reads the grouped
  // secret and the QR against the "secret" parameter of that same answer's own otpauth URI
  // — and the read afterwards is the twin that carries none of it.
  it(
    `§13/§15 · POST /api/hub/settings/two-factor/enable with the owner's own password answers 200 with the enrolment in its body — the grouped secret equal to the "secret" parameter of the same answer's otpauth URI, a QR served as a data:image/svg+xml URI, no error, and the ten backup codes from the same answer — with no Location and no \`next\` for any of it to ride, while the read afterwards says the factor is still off and carries none of it (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      const answered = await enable(session.cookie);
      // In the body, so there is no redirect for the secret to ride at all (§15).
      expect(answered.headers.get("Location"), "the enable answer set a Location").toBeNull();
      const { enrollment, backupCodes } = await enrolmentOf(answered);
      expect(Object.keys(enrollment).sort()).toEqual(["error", "qrDataUri", "secret", "totpUri"]);
      const secret = secretOf(enrollment.totpUri);
      // The grouped line is the SAME secret, spaced — not a second one minted for display.
      expect(enrollment.secret.replace(/\s/g, "")).toBe(secret);
      expect(enrollment.qrDataUri.startsWith("data:image/svg+xml"), "the QR is not an inline SVG").toBe(true);
      expect(enrollment.error).toBeNull();
      expect(backupCodes.length, "the enrolment carried no ten backup codes").toBe(10);

      // The twin: the read is the not-enrolled state, and nothing of the enrolment survives
      // into it — better-auth will not repeat any of it.
      const read = await settingsOf(session.cookie);
      expect(read.twoFactor).toEqual({ enabled: false });
      const raw = JSON.stringify(read);
      expect(raw, "the secret survived into the read").not.toContain(secret);
      expect(raw, "an otpauth URI survived into the read").not.toContain("otpauth:");
      expect(raw, "the QR survived into the read").not.toContain("data:image/svg+xml");
      for (const code of backupCodes) expect(raw, `${code} survived into the read`).not.toContain(code);
    },
  );

  // plan row 2. The negative that makes "in the body" structural rather than incidental.
  it(
    `§13/§15 · nothing on the enrolment journey puts the secret or a backup code on a URL: the enable answer carries them in its body and sets no Location; the verify refusal is a 422 carrying neither and no Location — the client redraws the enrolment it already holds, so nothing is posted back for the server to echo — and the verified answer's \`next\` carries none of them`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);

      const enabled = await enable(session.cookie);
      expect(enabled.headers.get("Location"), "the enable answer set a Location").toBeNull();
      const { enrollment, backupCodes } = await enrolmentOf(enabled);
      const secret = secretOf(enrollment.totpUri);
      expect(backupCodes.length).toBe(10);

      const refused = await settingsPost(settingsApi.totpVerify, { code: "000000" }, session.cookie);
      expect(refused.status).toBe(422);
      expect(refused.headers.get("Location"), "the verify refusal set a Location").toBeNull();
      const refusal = await refused.text();
      expect(refusal, "the refusal echoed the secret").not.toContain(secret);
      expect(refusal, "the refusal echoed an otpauth URI").not.toContain("otpauth:");
      for (const code of backupCodes) expect(refusal, `the refusal echoed ${code}`).not.toContain(code);

      const verified = await settingsPost(settingsApi.totpVerify, { code: await totpCode(secret) }, session.cookie);
      expect(verified.headers.get("Location"), "the verified answer set a Location").toBeNull();
      const { raw } = await redirectedOf(verified);
      expect(raw, "`next` carries the secret").not.toContain(secret);
      expect(raw, "`next` carries an otpauth URI").not.toContain("otpauth:");
      for (const code of backupCodes) expect(raw, `\`next\` carries ${code}`).not.toContain(code);
    },
  );

  // plan row 3. Its named trap survives the port: a successful verify DELETES the session it
  // ran under and mints a new one, and the route forwards that Set-Cookie — so the cookie
  // the test signed in with is dead the moment the POST returns, and the answer says
  // `reload` for exactly that reason.
  it(
    `§13 · a wrong code posted to POST /api/hub/settings/two-factor/verify-totp is a 422 carrying better-auth's own "Invalid code", and twoFactorEnabled is still 0 · the code generated from the SAME secret — which the refusal did not rotate — answers \`next\` on /settings/two-factor with done=two_factor_enable, re-issues the session cookie and says reload, and the read with THAT cookie says the factor is on (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);
      const { enrollment } = await enrolmentOf(await enable(session.cookie));
      const secret = secretOf(enrollment.totpUri);

      const refused = await settingsPost(settingsApi.totpVerify, { code: "000000" }, session.cookie);
      expect(refused.status, `POST ${settingsApi.totpVerify}`).toBe(422);
      // better-auth's own sentence, not one this hub wrote for it — the words the client
      // draws under the boxes of the enrolment it redraws.
      expect(await reasonOf(refused)).toContain("Invalid code");
      expect(await twoFactorEnabledOf(ns.owner.userId), "a wrong code enabled the factor").toBe(0);

      // The twin: the six digits an authenticator would show for that same secret, played
      // by the harness because nothing in the tree can produce them.
      const accepted = await settingsPost(settingsApi.totpVerify, { code: await totpCode(secret) }, session.cookie);
      const rotated = sessionCookieOf(accepted);
      expect(rotated, "the successful verify re-issued no session cookie").not.toBeNull();
      expect(rotated).not.toBe(session.cookie);
      const { next, reload } = await redirectedOf(accepted);
      expect(reload).toBe(true);
      expect(next.pathname).toBe(paths.settingsTwoFactor);
      expect(next.searchParams.get("done")).toBe("two_factor_enable");
      expect((await settingsOf(rotated ?? "")).twoFactor).toEqual({ enabled: true });
    },
  );

  // plan row 4, "/login's TOTP challenge stitches its six boxes into the one field
  // better-auth reads" — its second half retired with family 5, as the settings half did
  // with family 2: /login's card is the client's, its six boxes stitched into one `code`
  // field web-side. The field NAME is still pinned here, posted: row 23 and the TOTP sign-in
  // row below both send `code` to the kept verify route, the second one to a session.

  // plan row 5. "Fresh" is checkable because the enrolment's own ten are in hand: none of
  // them may appear in the new set. Its twins are the read, which reveals nothing, and the
  // wrong password, which lands a flash instead.
  it(
    `§13 · Regenerate backup codes answers 200 with a fresh set in its body — ten codes, none of them from the set the enrolment showed, no Location — while the read reveals none and a wrong password answers \`next\` on /settings/two-factor with failed=backup_codes_generate instead (the twin)`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      const session = await seedOwnerSession(ns.owner);
      // The enrolment's own set, which is what "fresh" is measured against.
      const { backupCodes: enrolled } = await enrolmentOf(await enable(session.cookie));
      expect(enrolled.length).toBe(10);
      // The enabled arm is the only one that offers Regenerate at all.
      await enrollTwoFactor(ns.owner.userId);

      const answered = await settingsPost(
        settingsApi.backupCodesGenerate,
        { password: SEEDED_OWNER_PASSWORD },
        session.cookie,
      );
      expect(answered.status, await answered.clone().text()).toBe(200);
      expect(answered.headers.get("Location"), "the regenerate answer set a Location").toBeNull();
      const body = await jsonOf(answered);
      expect(Object.keys(body)).toEqual(["backupCodes"]);
      const fresh = body.backupCodes as string[];
      expect(fresh.length, "the reveal carried no ten codes").toBe(10);
      expect(
        fresh.filter((code) => enrolled.includes(code)),
        "a regenerated code was one the enrolment already showed",
      ).toEqual([]);

      // The twins: the read reveals none …
      const raw = JSON.stringify(await settingsOf(session.cookie));
      for (const code of fresh) expect(raw, `${code} survived into the read`).not.toContain(code);
      // … and a wrong password has no set to show, so it takes the flash instead.
      const { next } = await redirectedOf(
        await settingsPost(settingsApi.backupCodesGenerate, { password: WRONG_PASSWORD }, session.cookie),
      );
      expect(next.pathname).toBe(paths.settingsTwoFactor);
      expect(next.searchParams.get("failed")).toBe("backup_codes_generate");
    },
  );

  // plan row 6, "the reveal carries a Copy-codes control that names every code it drew" —
  // retired with family 2: the reveal and its Copy control are the client's, over the ten
  // codes the bodies above carry.

  it(
    `§4/§13 · after a complete TOTP sign-in, the minted browser session opens /apps and the same Worker isolate still answers /login — the full password challenge and successful second-factor path, not enrollment verification`,
    async () => {
      const ns = await seedNamespace(env.DB, {});
      await seedOwnerCredential(ns.owner.userId);
      const enrollmentSession = await seedOwnerSession(ns.owner);
      const { enrollment } = await enrolmentOf(await enable(enrollmentSession.cookie));
      const secret = secretOf(enrollment.totpUri);
      await redirectedOf(
        await settingsPost(settingsApi.totpVerify, { code: await totpCode(secret) }, enrollmentSession.cookie),
      );
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

      const challenge = loginIslandOf(await anonymousPage(challengeUrl));
      expect(challenge.step.kind, "the challenge landed on no TOTP card").toBe("totp");
      const verified = await formPost(
        webPaths.totpVerify,
        // What the client's TOTP card posts: the stitched code, and the island's landing.
        { code: await totpCode(secret), callbackURL: challenge.redirectTo ?? paths.apps },
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

/** The Tokens pane's read-only world: one tunneled app holding one key, one agent holding
 *  one key. Both slugs are `uniqueSlug`-distinct, so a claim about the read naming a slug
 *  cannot be satisfied by a word the fixture uses elsewhere. */
const KEYS_APP = uniqueSlug("keysapp");
const KEYS_AGENT = uniqueSlug("keysagt");

describe(`§13 · the Tokens pane`, () => {
  // Ported with decision 38's family 2: the pane's server facts are the read's `tokens` rows
  // and its one write is POST /api/hub/settings/tokens/token_revoke. Retired to the client,
  // each where its row stood: the bound-to links (/apps/<slug>, /agents/<slug>), the
  // **All · Agents · Apps** filter and the marker narrowing with it (the pure `tokenKindOf`,
  // web-side), Revoke-vs-Remove as a LABEL, the absent Issue control and §13's intro and
  // footer sentences, and the column names.

  let keys: { ns: SeededNamespace; session: SeededSession };

  beforeAll(async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: KEYS_APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: KEYS_AGENT, tokens: [{ as: "agt" }] }],
    });
    keys = { ns, session: await seedOwnerSession(ns.owner) };
  });

  it(`§13 · the read lists every key in the namespace, agent and app alike — its token ids are exactly token_list's unrevoked set, each row carrying its display prefix, its kind and the slug it is bound to — and it takes no filter: a \`?kind=\` on the read changes nothing, because the All · Agents · Apps filter narrows the TABLE the client draws, never the read (token_list takes no arguments at all)`, async () => {
    const live = (await tokensOf(keys.ns.owner.userId)).filter((row) => row.revokedAt === null);
    // The precondition the claim rests on: this namespace really does hold BOTH kinds.
    expect(new Set(live.map((row) => row.kind))).toEqual(new Set(["agent", "app"]));

    const read = await settingsOf(keys.session.cookie);
    expect(
      new Map(read.tokens.map((row) => [row.id, [row.prefix, row.kind, row.boundTo]])),
    ).toEqual(new Map(live.map((row) => [row.id, [row.prefix, row.kind, row.refSlug]])));

    const narrowed = await hub("GET", "/api/hub/settings?kind=agent", undefined, { cookie: keys.session.cookie });
    expect(((await narrowed.json()) as SettingsRead).tokens.map((row) => row.id).sort()).toEqual(
      read.tokens.map((row) => row.id).sort(),
    );
    expect(schemaKeysOf(ops.token_list)).toEqual([]);
  });

  it(`§13 · Revoke walks end to end: POST /api/hub/settings/tokens/token_revoke with a live key's id answers \`next\` exactly /settings/tokens?done=token_revoke, and the key is gone from the read while token_list still reports its row revoked · the other key is still listed (the twin)`, async () => {
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

    const { raw } = await redirectedOf(
      await settingsPost(settingsApi.tokenRevoke, { id: appKey?.id }, session.cookie),
    );
    expect(raw).toBe(`${paths.settingsTokens}?done=token_revoke`);

    // §13's "revoked rows are not listed" located in the READ, with §8's op unchanged.
    const after = (await settingsOf(session.cookie)).tokens.map((row) => row.id);
    expect(after).not.toContain(appKey?.id);
    const relisted = await tokensOf(ns.owner.userId);
    // A stamp, not `not.toBeNull()`: `find` yields `undefined` for a row the op DROPPED, and
    // `undefined` is not null — the drift this leg exists to catch would have passed.
    expect(
      relisted.find((row) => row.id === appKey?.id)?.revokedAt,
      "token_list stopped reporting the revoked row",
    ).toEqual(expect.any(Number));
    // Non-vacuous: the other key is still listed, so the list did not simply empty.
    expect(after).toContain(agentKey?.id);
  });

  it(`§13 · an expired key is a read row marked \`expired: true\` where a live key is \`expired: false\` — what the client's Remove-vs-Revoke label is drawn from — and both leave through the same token_revoke write (the twin)`, async () => {
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

    const flags = new Map((await settingsOf(session.cookie)).tokens.map((row) => [row.id, row.expired]));
    expect(flags).toEqual(
      new Map([
        [dead?.id, true],
        [live?.id, false],
      ]),
    );

    // Remove is the same mutation and not a no-op — and the live twin is still there.
    const { raw } = await redirectedOf(await settingsPost(settingsApi.tokenRevoke, { id: dead?.id }, session.cookie));
    expect(raw).toBe(`${paths.settingsTokens}?done=token_revoke`);
    expect((await settingsOf(session.cookie)).tokens.map((row) => row.id)).toEqual([live?.id]);
  });
});

describe(`§13/§19 · the Connected clients pane`, () => {
  // Ported with decision 38's family 2: the pane's server facts are the read's `connections`
  // rows and its one write is POST /api/hub/settings/clients/connection_revoke. The name
  // and origin as TEXT, the Acts-as link, the "unverified" badge, the `active`/`revoked`
  // words and §13's footer are the client's to draw.

  it(`§13/§19 · GET /oauth/connections answers 301 to /settings/clients, and the read that pane draws from lists the binding — the redirect's code and target are pinned, not merely "a redirect"`, async () => {
    await consentOnce(world.ns, world.session.cookie, "agent", { client_name: "Listed Client" });

    // 301 exactly — §13 pins the CODE, because the move is permanent and a 302 would leave
    // every bookmark coming back here forever.
    const redirected = await get(paths.oauthConnections);
    expect(redirected.status).toBe(301);
    expect(redirected.headers.get("Location")).toBe(paths.settingsClients);
    // Nothing is asserted about the anonymous case: /oauth/connections is not under
    // /settings/* and §13 pins no gate for it.
    expect((await settingsOf(world.session.cookie)).connections.map((row) => row.clientName)).toContain(
      "Listed Client",
    );
  });

  it(`§13/§19 · the connections POST moved with its pane, twice: nothing routes /oauth/connections/connection_revoke, and since decision 38 nothing routes /settings/clients/connection_revoke either — each reaches connection_revoke zero times and answers no redirect · the same revoke at POST /api/hub/settings/clients/connection_revoke reaches it exactly once and lands on the pane (the twin)`, async () => {
    const AGENT = uniqueSlug("movagt");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const { bindingId } = await consentOnce(ns, session.cookie, AGENT, {
      client_name: uniqueSlug("movcli"),
    });
    const csrf = await csrfFor(session.cookie);

    await withCountedOps(["connection_revoke"], async (invocations) => {
      // Spelled literally on purpose: these are the strings that must no longer route, so
      // they cannot come from `paths`.
      for (const gone of [
        `/oauth/connections/connection_revoke?id=${bindingId}`,
        `/settings/clients/connection_revoke?id=${bindingId}`,
      ]) {
        const answered = await post(gone, {}, { cookie: session.cookie, csrf });
        // Observed 404s: the `oauth` mount's own tail, and the page router's own. What
        // §13 pins is that the op is not reached and nothing redirects.
        expect(answered.status, `POST ${gone}`).toBeGreaterThanOrEqual(400);
        expect(answered.headers.get("Location"), `POST ${gone}`).toBeNull();
      }
      expect(times(invocations, "connection_revoke")).toBe(0);

      const { next } = await redirectedOf(
        await settingsPost(settingsApi.connectionRevoke, { id: bindingId }, session.cookie, csrf),
      );
      expect(next.pathname).toBe(paths.settingsClients);
      expect(times(invocations, "connection_revoke")).toBe(1);
    });
    // "No rendered page posts under the old path" is the client's now: the bundle posts
    // through `settingsApi`, which case 24 pins whole.
  });

  it(`§13/§19.5 · a connected client's read row carries the name it registered with and the ORIGIN of its registered redirect URI — never the full URI — and the bound agent's slug · a client that registered without a name carries null there and its client id beside it (the twin)`, async () => {
    const AGENT = uniqueSlug("acts");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const named = `Named ${uniqueSlug("named")}`;
    const { clientId: namedId } = await consentOnce(ns, session.cookie, AGENT, {
      client_name: named,
      redirect_uris: [REDIRECT_A],
    });
    // GENUINELY absent, not `""`: `listConnections` coalesces with `??`, so an empty string
    // would survive as `""` and pin a state §13 never describes.
    const { clientId: nameless } = await consentOnce(ns, session.cookie, AGENT, {
      client_name: undefined,
      redirect_uris: [REDIRECT_B],
    });

    const rows = new Map((await settingsOf(session.cookie)).connections.map((row) => [row.clientId, row]));
    expect(rows.get(namedId)).toMatchObject({ clientName: named, redirectOrigin: new URL(REDIRECT_A).origin, agentSlug: AGENT });
    expect(rows.get(nameless)).toMatchObject({ clientName: null, redirectOrigin: new URL(REDIRECT_B).origin, agentSlug: AGENT });
    // The origin is a strict prefix of the URI, so only the ABSENCE carries the claim.
    expect(JSON.stringify([...rows.values()]), "the read carries a whole redirect URI").not.toContain(REDIRECT_A);
  });

  it(`§13/§19.5 · a self-registered (DCR) client's read row says \`selfRegistered: true\` — what the client's "unverified" marker is drawn from · a client registered under the owner's own session says false (the twin) — the consent screen's second identity string, repeated on the pane`, async () => {
    const dcr = await oneConnectedNamespace(uniqueSlug("dcr"));
    const known = await oneConnectedNamespace(uniqueSlug("known"), true);
    expect((await settingsOf(dcr.session.cookie)).connections.map((row) => [row.clientName, row.selfRegistered])).toEqual([
      [dcr.client, true],
    ]);
    expect((await settingsOf(known.session.cookie)).connections.map((row) => [row.clientName, row.selfRegistered])).toEqual([
      [known.client, false],
    ]);
  });

  it(`§13/§19.6 · Revoke walks end to end from an active row: POST /api/hub/settings/clients/connection_revoke answers \`next\` exactly /settings/clients?done=connection_revoke, and the row STAYS in the read as revoked — re-consent revives it — while it was active before (the twin)`, async () => {
    const AGENT = uniqueSlug("revcagt");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const client = uniqueSlug("revcli");
    const { clientId, bindingId } = await consentOnce(ns, session.cookie, AGENT, { client_name: client });

    const rowOf = async () =>
      (await settingsOf(session.cookie)).connections.find((row) => row.clientId === clientId);
    // The twin, asserted BEFORE the post: while it was active, it carried no revocation.
    expect((await rowOf())?.revokedAt).toBeNull();

    const { raw } = await redirectedOf(
      await settingsPost(settingsApi.connectionRevoke, { id: bindingId }, session.cookie),
    );
    expect(raw).toBe(`${paths.settingsClients}?done=connection_revoke`);

    // A revoked row STAYS listed, because re-consent revives it (§19.4's UNIQUE pair).
    const after = await rowOf();
    expect(after, "the revoked client left the read").toBeDefined();
    expect(after?.clientName).toBe(client);
    expect(after?.revokedAt).toEqual(expect.any(Number));
  });

  it(`§13 · a write to either ops-backed settings route without \`X-Pmcp-Csrf\` is 403 and nothing is revoked · the same write carrying the session's token succeeds (the twin) — one gate over the prefix, proven on both routes`, async () => {
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

    // Each leg carries the read of ITS OWN row, because the twin below revokes as it goes.
    const legs = [
      {
        path: settingsApi.tokenRevoke,
        id: tokenId,
        revokedAt: async (): Promise<number | null> =>
          (await tokensOf(ns.owner.userId)).find((row) => row.id === tokenId)?.revokedAt ?? null,
      },
      {
        path: settingsApi.connectionRevoke,
        id: bindingId,
        revokedAt: async (): Promise<number | null> =>
          (await bindingFor(ns.owner.userId, clientId))?.revokedAt ?? null,
      },
    ];
    let walked = 0;
    for (const leg of legs) {
      // No header at all — the shape of a cross-site request.
      const refused = await settingsPost(leg.path, { id: leg.id }, session.cookie, null);
      expect(refused.status, `POST ${leg.path} with no X-Pmcp-Csrf`).toBe(403);
      // The refusal did not answer 403 AFTER mutating.
      expect(await leg.revokedAt(), `the refused POST ${leg.path} revoked its row`).toBeNull();

      await redirectedOf(await settingsPost(leg.path, { id: leg.id }, session.cookie));
      expect(await leg.revokedAt(), `the accepted POST ${leg.path} revoked nothing`).not.toBeNull();
      walked += 1;
    }
    // Two routes, not one: "they share a handler" is an assumption about code.
    expect(walked, "the walk did not cover both routes").toBe(2);
  });

  it(`§19.4/§13 · consenting again after a revoke revives the same row — the read holds exactly one row for that client, active again, and oauth_binding still holds exactly one row for the pair`, async () => {
    const AGENT = uniqueSlug("reagt");
    const ns = await seedNamespace(env.DB, { agents: [{ slug: AGENT }] });
    const session = await seedOwnerSession(ns.owner);
    const client = uniqueSlug("recli");
    const { clientId, bindingId } = await consentOnce(ns, session.cookie, AGENT, { client_name: client });
    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);

    await redirectedOf(await settingsPost(settingsApi.connectionRevoke, { id: bindingId }, session.cookie));
    // The pair survives the revoke: an implementation that DELETED the row instead of
    // marking it revoked reads 0 here, and §19.4's UNIQUE (owner_id, client_id) is the
    // whole reason re-consent revives rather than duplicates.
    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);
    const rowsOf = async () =>
      (await settingsOf(session.cookie)).connections.filter((row) => row.clientId === clientId);
    // The revoked state BETWEEN the two consents is what makes "revives" non-vacuous.
    expect((await rowsOf()).map((row) => row.revokedAt === null)).toEqual([false]);

    await consentAgain(ns, session.cookie, AGENT, clientId);

    expect(await countBindings(ns.owner.userId, clientId)).toBe(1);
    expect((await rowsOf()).map((row) => [row.id, row.revokedAt])).toEqual([[bindingId, null]]);
  });

  it(`§8 · the Tokens and Connected clients writes DO front ops, and each one's body is exactly its op's own keys — schemaKeysOf(ops[name]) — so a body carrying one more key is refused 422 by the op's own parseInput and revokes nothing · the op's own keys revoke (the twin)`, async () => {
    // Ported with family 2 from "each form's field set equals schemaKeysOf(ops[name])":
    // the body is the op's input, handed through with no second validator, so parity
    // direction B is the op's own refusal of anything else.
    const AGENT = uniqueSlug("dirbagt");
    const APP = uniqueSlug("dirbapp");
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: APP, kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: AGENT, tokens: [{ as: "agt" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const { clientId, bindingId } = await consentOnce(ns, session.cookie, AGENT, { client_name: uniqueSlug("dirbcli") });
    const tokenId = (await tokensOf(ns.owner.userId))[0].id;

    for (const { path, op, id, revokedAt } of [
      {
        path: settingsApi.tokenRevoke,
        op: "token_revoke",
        id: tokenId,
        revokedAt: async () => (await tokensOf(ns.owner.userId)).find((row) => row.id === tokenId)?.revokedAt ?? null,
      },
      {
        path: settingsApi.connectionRevoke,
        op: "connection_revoke",
        id: bindingId,
        revokedAt: async () => (await bindingFor(ns.owner.userId, clientId))?.revokedAt ?? null,
      },
    ]) {
      expect(schemaKeysOf(ops[op]), `${op}'s own keys`).toEqual(["id"]);
      const refused = await settingsPost(path, { id, nonesuch: "1" }, session.cookie);
      expect(refused.status, `POST ${path} with an extra key`).toBe(422);
      expect(await reasonOf(refused)).toContain("does not declare");
      expect(await revokedAt(), `the refused POST ${path} revoked anyway`).toBeNull();

      const { next } = await redirectedOf(await settingsPost(path, { id }, session.cookie));
      expect(next.searchParams.get("done")).toBe(op);
      expect(await revokedAt()).not.toBeNull();
    }
  });

  it(`§13 · the two Access lists part company on a revoked row by design: the read's tokens are the rows the Tokens pane lists — the live key and the expired one, never the revoked one — while its connections keep a revoked client among them · revoking through each write then shortens the tokens by one and the connections by none (the twin)`, async () => {
    // The complement of the "one read carries every list" row, which seeds four LIVE keys
    // and no revoked or expired one — leaving both lists satisfiable by a query the shell
    // rule forbids.
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
    const bindingA = await consentOnce(ns, session.cookie, AGENT, { client_name: uniqueSlug("markcla") });
    const bindingB = await consentOnce(ns, session.cookie, AGENT, { client_name: uniqueSlug("markclb") });
    // A is revoked through the OP, leaving the pane's own write unspent for the delta.
    await ops.connection_revoke.handler(ns.owner.userId, { id: bindingA.bindingId });

    const seeded = (await tokensOf(ns.owner.userId)).filter((row) => row.refSlug === KEYS);
    const dead = seeded.filter((row) => row.revokedAt !== null);
    const stale = seeded.filter(
      (row) => row.revokedAt === null && row.expiresAt !== null && row.expiresAt <= Date.now(),
    );
    const live = seeded.filter(
      (row) => row.revokedAt === null && (row.expiresAt === null || row.expiresAt > Date.now()),
    );
    expect([seeded.length, live.length, stale.length, dead.length]).toEqual([3, 1, 1, 1]);

    // TOKENS: 3 is the token_list().length bug and 1 the live-keys-only bug.
    const before = await settingsOf(session.cookie);
    expect(new Set(before.tokens.map((row) => row.id))).toEqual(new Set([live[0].id, stale[0].id]));
    // CLIENTS: 2 with a revoked row among them — the leg a live-bindings-only 1 fails.
    expect(before.connections.length).toBe(2);
    expect(before.connections.filter((row) => row.revokedAt !== null).map((row) => row.id)).toEqual([
      bindingA.bindingId,
    ]);

    // THE DELTA, each through its own write.
    await redirectedOf(await settingsPost(settingsApi.tokenRevoke, { id: live[0].id }, session.cookie));
    await redirectedOf(await settingsPost(settingsApi.connectionRevoke, { id: bindingB.bindingId }, session.cookie));
    const after = await settingsOf(session.cookie);
    // A drop to 0 would mean the write revoked more than it named.
    expect(after.tokens.map((row) => row.id)).toEqual([stale[0].id]);
    expect(after.connections.length).toBe(2);
    expect(after.connections.every((row) => row.revokedAt !== null)).toBe(true);
  });
});

describe(`§23 · /settings/execution — the timeout pair`, () => {
  // Ported with decision 38's family 2: the pair is the read's `execution`, its bounds the
  // read's `limits`, and the Save is POST /api/hub/settings/execution/hub_settings_update,
  // whose refusal is the op's own field-scoped violations. Drawing each sentence under the
  // control it names, in the owner's own text, is the client's (routes §2's
  // `executionErrors`, web-side); so is the rail marker "45s / 120s" (`timeoutLabel`).

  it(`§23 · the read carries hub_settings_get's committed pair in milliseconds beside the op's own minimum and ceiling`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    // A pair that is NOT the pinned default, so a read answering constants cannot pass.
    await ops.hub_settings_update.handler(ns.owner.userId, { default_timeout_ms: 45_000, max_timeout_ms: 120_000 });

    const read = await settingsOf(session.cookie);
    expect(read.execution).toEqual({ defaultTimeoutMs: 45_000, maxTimeoutMs: 120_000 });
    expect([read.limits.minTimeoutMs, read.limits.maxTimeoutMs]).toEqual([HUB_MIN_TIMEOUT_MS, HUB_HARD_MAX_TIMEOUT_MS]);
  });

  it(`§23 · a valid Save — the owner's text in both controls — writes the pair and answers \`next\` on the pane with done=hub_settings_update, and the read afterwards carries the committed pair — with exactly one admin.hub_settings_update row`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);

    const { next } = await redirectedOf(
      await settingsPost(
        settingsApi.executionUpdate,
        { default_timeout_ms: "60000", max_timeout_ms: "150000" },
        session.cookie,
      ),
    );
    expect(next.pathname).toBe(paths.settingsExecution);
    expect(next.searchParams.get("done")).toBe("hub_settings_update");
    expect((await query(env.DB, ns.owner.userId, { event: "admin.hub_settings_update" })).total).toBe(1);
    expect((await settingsOf(session.cookie)).execution).toEqual({ defaultTimeoutMs: 60_000, maxTimeoutMs: 150_000 });
  });

  it(`§23 · an invalid pair is a 422 carrying the op's own violations, each naming the control's field — the ordering rule, the floor and a non-integer each land on default_timeout_ms — and writes nothing (the twins)`, async () => {
    const ns = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(ns.owner);
    const before = (await query(env.DB, ns.owner.userId, {})).total;

    for (const [typed, sentence] of [
      [{ default_timeout_ms: "200000", max_timeout_ms: "100000" }, 'must not exceed "max_timeout_ms"'],
      [{ default_timeout_ms: "500", max_timeout_ms: "30000" }, "is below the minimum this tool accepts"],
      [{ default_timeout_ms: "soon", max_timeout_ms: "30000" }, "has the wrong type"],
    ] as const) {
      const refused = await settingsPost(settingsApi.executionUpdate, { ...typed }, session.cookie);
      expect(refused.status, typed.default_timeout_ms).toBe(422);
      const body = await jsonOf(refused);
      expect(typeof body.reason, typed.default_timeout_ms).toBe("string");
      expect(body.violations, typed.default_timeout_ms).toEqual([
        { field: "default_timeout_ms", reason: expect.stringContaining(sentence) },
      ]);
    }
    expect((await query(env.DB, ns.owner.userId, {})).total, "a refused pair wrote").toBe(before);
    expect((await settingsOf(session.cookie)).execution).toEqual({ defaultTimeoutMs: 30_000, maxTimeoutMs: 30_000 });
  });
});

describe(`§13 · the /settings form targets are gone (decision 38)`, () => {
  it(`§13 · every POST target the settings panes' forms used — the eight credential targets, /settings/tokens/token_revoke, /settings/clients/connection_revoke and /settings/execution/hub_settings_update — answers 404 with no Location to a fresh session carrying its own CSRF field, reaches no op and changes nothing · the JSON write beside each is what answers now (the prefix describe's walk)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "app" }] }],
      agents: [{ slug: "agent" }],
    });
    const session = await seedOwnerSession(ns.owner);
    const passkeyId = await plantPasskey(ns.owner.userId, { name: "MacBook Touch ID" });
    const tokenId = (await tokensOf(ns.owner.userId))[0].id;
    const csrf = await csrfFor(session.cookie);
    // Spelled literally on purpose: these are the paths that must no longer route, and
    // `paths` names none of them since family 5 deleted the templates that drew them.
    const targets = [
      "/settings/two-factor/enable",
      "/settings/two-factor/verify-totp",
      "/settings/two-factor/disable",
      "/settings/two-factor/generate-backup-codes",
      "/settings/passkey/delete-passkey",
      "/settings/revoke-session",
      "/settings/revoke-other-sessions",
      "/settings/change-password",
      `/settings/tokens/token_revoke?id=${encodeURIComponent(tokenId)}`,
      "/settings/clients/connection_revoke?id=no-such-connection",
      "/settings/execution/hub_settings_update",
    ];
    expect(targets.length).toBe(11);
    const before = await settingsOf(session.cookie);

    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      for (const target of targets) {
        const answered = await formPost(
          target,
          { csrf, password: SEEDED_OWNER_PASSWORD, id: passkeyId, default_timeout_ms: "60000", max_timeout_ms: "60000" },
          session.cookie,
        );
        expect(answered.status, `POST ${target}`).toBe(404);
        expect(answered.headers.get("Location"), `POST ${target}`).toBeNull();
      }
      expect([...invocations.keys()].filter((name) => times(invocations, name) > 0)).toEqual([]);
    });
    const after = await settingsOf(session.cookie);
    expect(after.passkeys).toEqual(before.passkeys);
    expect(new Set(after.sessions.map((row) => row.id))).toEqual(new Set(before.sessions.map((row) => row.id)));
    expect(after.twoFactor).toEqual(before.twoFactor);
    expect(after.execution).toEqual(before.execution);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
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
    { cookie, csrf: bootstrapCsrfOf(html) },
  );
  expect(accepted.status, await accepted.text()).toBe(303);
}

/** The seven rail entries' URLs, in the brief's table order — built from `paths`, never
 *  spelled, so a pane added to `APP_PANES` is walked with no edit here. */
function appRailHrefs(slug: string): string[] {
  return APP_PANES.map((pane) => paths.appPane(slug, pane));
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
 * own `/oauth/consent` (§19.5 step 2) and returns the shell document it answered (whose
 * bootstrap carries the CSRF token the consent form posts) and the screen's read, beside
 * the RAW signed query the redirect carried — the bytes the read must echo.
 */
async function reachConsent(
  clientId: string,
  cookie: string,
  extra: Record<string, string> = {},
): Promise<{ response: Response; html: string; oauthQuery: string; read: ConsentRead }> {
  const authorized = await call(new Request(authorizeUrl(clientId, extra), { headers: { Cookie: cookie } }));
  expect(authorized.status, "authorize did not redirect to consent").toBe(302);
  const location = authorized.headers.get("Location") ?? "";
  expect(location, `authorize did not land on /oauth/consent: ${location}`).toMatch(/^\/oauth\/consent\?/);
  const oauthQuery = location.split("?")[1] ?? "";
  const response = await call(new Request(`${ORIGIN}${location}`, { headers: { Cookie: cookie } }));
  const html = await response.text();
  expect(response.status, html).toBe(200);
  const read = await consentReadOf(oauthQuery, cookie);
  expect(read.status, await read.clone().text()).toBe(200);
  return { response, html, oauthQuery, read: (await read.json()) as ConsentRead };
}

/** `GET /api/hub/oauth/consent` as the SPA asks it: the signed query appended VERBATIM —
 *  never parsed, rebuilt or re-encoded (§19.5 step 3's amendment). `cookie` null is the
 *  signed-out fetch. */
function consentReadOf(oauthQuery: string, cookie: string | null): Promise<Response> {
  return hub("GET", `/api/hub/oauth/consent?${oauthQuery}`, undefined, { cookie });
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

/* ------------------------------------------------------------------ *
 * Reading the pages back
 * ------------------------------------------------------------------ */

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
 * The settings panes (§13)
 * ------------------------------------------------------------------ */

/** §13's seven settings panes in rail order, read through `paths` and never respelled —
 *  the shell URLs the prefix-gate rows walk. (The rail walkers that read their markup went
 *  with decision 38's family 2: the client draws the rail now.) */
const PANES: readonly string[] = [
  paths.settings,
  paths.settingsTwoFactor,
  paths.settingsPasskeys,
  paths.settingsSessions,
  paths.settingsTokens,
  paths.settingsClients,
  paths.settingsExecution,
];

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
    { cookie, csrf: bootstrapCsrfOf(html) },
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
