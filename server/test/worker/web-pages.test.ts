// web-pages.test.ts — the browser surface, kept thin on purpose. §13's pages carry no
// business logic, so this suite deliberately pins only what is TRUE OF THE PAGES and false
// nowhere else: the CSRF gate (with the ops handler provably not run — a 403 that still
// mutated is the failure this file exists to catch), cookie-session-only access with
// `/approvals/<id>` owner-only, the one paging contract behind two presentations
// (`{ rows, total }`) with the JSONL export's line count equal to `total`, parity
// DIRECTION B: every mutating form's fields are exactly the fronted op's schema keys — and
// §4's recent-auth gate on /settings's credential MUTATIONS, not merely on its read.
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
// truth, and maintaining it is precisely the drift Direction B exists to catch.
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
import type { AdminOp } from "../../src/admin";
import { AGENT_PANES, APP_PANES, RESERVED_APP_SLUGS } from "../../src/app-routes";
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
import { schemaLeaves } from "../../src/catalog-view";
import { paths, SETTINGS_CONFIRM_PANE } from "../../src/pages/model";
import type { ConnectionRow, SettingsConfirm } from "../../src/pages/model";
import { tokenPattern } from "../../src/principal";
import {
  buildToolFilter,
  PMCP_SLUG,
  Registry,
  validateSchemaIndirection,
  writeOnlyPaths,
} from "../../src/registry";
import type { App, AppCapability, GrantEntry, RoleDeclaration } from "../../src/registry";
import { beginConnect } from "../../src/upstream";
import { AS_HOST, registerOverride, upstreamUrlFor } from "../harness/fake-upstream";
import type { AsScenario, UpstreamScenario } from "../harness/fake-upstream";
import { seedApp, seedNamespace, seedOwnerCredential, seedOwnerSession, seedToken, SEEDED_OWNER_PASSWORD, uniqueSlug } from "../harness/seed";
import { totpCode } from "../harness/totp";
import type { SeededNamespace, SeededSession, TokenSpec } from "../harness/seed";

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

/** The same declaration read for what it REQUIRES. Direction B's strict field-set equality
 *  cannot describe an op with an optional field no §13 control fills (`token_issue`'s
 *  `expires_in`), so a walk over such an op states the containment instead — still derived
 *  on both sides, and still nothing hand-maintained. */
function requiredKeysOf(op: AdminOp): string[] {
  // deps: admin.AdminOp.schema
  const fields = (op.schema as { fields: Record<string, { optional?: true }> }).fields;
  return Object.keys(fields)
    .filter((name) => fields[name].optional === undefined)
    .sort();
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

/** How many audit rows the paging and export cases are written against. */
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
 * The audit rows every paging and export case reads. Written through `audit.record` —
 * the one write path — so what the page pages over is what the hub actually stores,
 * bodies and stubs included (§15).
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
  fields: Record<string, string>,
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
 *  Sign out, all six settings panes, and the destructive confirm dialogs, which is where
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
  it("1. §13 · a mutating POST with no CSRF field is 403 AND the substituted ops handler was never invoked (a rejected-but-executed mutation is the bug this case exists for)", async () => {
    await withCountedOps(["app_archive"], async (invocations) => {
      const refused = await post(paths.appArchive("news"), {});
      expect(refused.status).toBe(403);
      expect(times(invocations, "app_archive")).toBe(0);
    });
  });

  it("2. §13 · the same POST carrying the token the page rendered succeeds and the handler ran exactly once (the allow-twin of 1 — without it, `throw 403` passes)", async () => {
    await withCountedOps(["app_archive"], async (invocations) => {
      const csrf = csrfOf(await page(paths.apps));
      const accepted = await post(paths.appArchive("news"), {}, { csrf });
      expect(accepted.status).toBe(303);
      expect(accepted.headers.get("Location")).toContain(paths.apps);
      expect(times(invocations, "app_archive")).toBe(1);
      // The op received the slug the target named — the query string IS the argument.
      expect(invocations.get("app_archive")?.[0]).toMatchObject({ slug: "news" });
    });
  });

  it("3. §13 · a token minted under a different cookie session is 403, handler not invoked", async () => {
    await withCountedOps(["app_archive"], async (invocations) => {
      const foreignToken = csrfOf(await page(paths.apps, world.other.cookie));
      const refused = await post(paths.appArchive("news"), {}, { csrf: foreignToken });
      expect(refused.status).toBe(403);
      expect(times(invocations, "app_archive")).toBe(0);
      // The twin, so "403" is not simply what this endpoint always answers: the SAME
      // session's own token passes.
      const own = csrfOf(await page(paths.apps));
      expect((await post(paths.appArchive("news"), {}, { csrf: own })).status).toBe(303);
      expect(times(invocations, "app_archive")).toBe(1);
    });
  });

  it("4. §13 · every mutating form the pages render carries a CSRF field — walked out of the rendered HTML, never listed, so a new form cannot forget one", async () => {
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
  });

  it("5. §13 · /audit renders no mutating form and needs no token (no mutations, no CSRF surface)", async () => {
    const html = await page(paths.audit);
    // Nothing on this page fronts a tool, and the one POST form it carries is the signed-in
    // shell's Sign out — better-auth's endpoint, present on every shelled page and owned by
    // §4 rather than by /audit.
    for (const form of formsRenderedOn(html)) {
      expect(Object.prototype.hasOwnProperty.call(ops, form.op), `/audit fronts "${form.op}"`).toBe(false);
      expect(BETTER_AUTH_ACTIONS.has(form.op), `/audit posts to "${form.op}"`).toBe(true);
    }
    // No token is rendered at all, because the props carry none: /audit mutates nothing.
    expect(html).not.toContain('name="csrf"');
    // Its own controls are all GETs — the filter form included, which is why it needs none.
    expect(html).toContain('method="get"');
  });
});

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

  it("8. §13 · /approvals/<id> for another namespace's approval refuses · the owner's own id renders (owner-only, and indistinguishable from a nonexistent id)", async () => {
    const own = await get(paths.approval(world.approvalId));
    expect(own.status).toBe(200);
    expect(await own.text()).toContain(world.approvalId);
    const foreign = await get(paths.approval(world.foreign.approvalId));
    const invented = await get(paths.approval("apr_this-id-never-existed"));
    expect(foreign.status).toBe(404);
    // The two refusals are ONE answer: a probe cannot learn that the id exists elsewhere.
    expect(await foreign.text()).toEqual(await invented.text());
    expect(foreign.status).toBe(invented.status);
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

describe("§13/§8 · /apps/new — proxied states: field-scoped refusals, the URL rule, several at once, and the connecting page", () => {
  /** The sentence §8's endpoint rule produces, as the OP spells it (§13 shows it capitalised
   *  with a period; both spellings are pinned below, from this one string). */
  const ENDPOINT_REASON = `"endpoint" must be an https:// URL (http:// only for localhost)`;
  const ENDPOINT_SHOWN = "Must be an https:// URL (http:// only for localhost).";

  /** The reserved page segment `app_create` refuses — read off the route table, never
   *  spelled, so a segment added later is walked here with no edit. Its sentence names no
   *  field in quotes at all, which is what makes it the discriminator these rows need: a
   *  message SCAN files it under the whole form, and only the violation's own `field`
   *  puts it under Slug. */
  const RESERVED_SLUG = [...RESERVED_APP_SLUGS][0];

  /** The add-app form as /apps/new drew it, filled the way a human fills it and posted with
   *  the token that render carried. Every case here goes through this, so none can submit a
   *  control the page never rendered (`typedInto` refuses one). */
  async function submitNewApp(typed: Record<string, string>): Promise<Response> {
    const rendered = await page(paths.appNew);
    const [drawn] = formsPostingTo(rendered, paths.appCreate);
    expect(drawn, "/apps/new rendered no create form").toBeDefined();
    return post(paths.appCreate, typedInto(drawn, typed), { csrf: csrfOf(rendered) });
  }

  /** One field of the add-app form as it came back: whether its control is `aria-invalid`,
   *  and the sentence drawn under it. Split on the field wrapper rather than parsed — the
   *  same shallow walk every other case in this file does to HTML. */
  function fieldOf(
    html: string,
    control: "name" | "slug" | "endpoint",
  ): { invalid: boolean; error: string | null } {
    const chunk = html.split(`<div class="field"`).find((part) => part.includes(`id="app-${control}"`)) ?? "";
    const error = /<div class="field-error">([\s\S]*?)<\/div>/.exec(chunk)?.[1];
    return { invalid: chunk.includes(`aria-invalid="true"`), error: error === undefined ? null : textOf(error) };
  }

  /** The whole-form message the card draws above the fields, or null. */
  function formAlert(html: string): string | null {
    const alert = /<div class="alert alert--danger">([\s\S]*?)<\/div>/.exec(html)?.[1];
    return alert === undefined ? null : textOf(alert);
  }

  /** A page's links as label → href. The connecting card's two buttons are anchors, so a
   *  walk over `<a>` is how "what the owner can click next" is described. */
  function linksOf(html: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const anchor of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      found[textOf(anchor[2])] = decodeEntities(attributeOf(anchor[1], "href") ?? "");
    }
    return found;
  }

  /** Every app slug this namespace holds — "nothing created" read the way §8 reports it. */
  async function slugsOf(): Promise<string[]> {
    const listed = (await ops.app_list.handler(world.ns.owner.userId, {})) as { apps: { slug: string }[] };
    return listed.apps.map((app) => app.slug);
  }

  it("§13/§8 · a refusal lands under the control it names — the field read off the refusal's own violations, never a substring of its message — with aria-invalid on that input and the op's sentence beneath it (capitalised, one period), the rest of the form echoed back at 400 and nothing created · a well-formed proxied headers create succeeds and lands on the created card (the twin)", async () => {
    const endpoint = "https://mcp.example.com/mcp";
    const refused = await submitNewApp({
      kind: "proxy",
      authMode: "headers",
      name: "Reserved",
      slug: RESERVED_SLUG,
      endpoint,
    });
    expect(refused.status).toBe(400);
    const redrawn = await refused.text();

    // Under Slug, with the control marked — and the sentence itself quotes no field name,
    // so a substring scan over the message could not have put it there.
    expect(fieldOf(redrawn, "slug")).toEqual({
      invalid: true,
      error: `The slug "${RESERVED_SLUG}" is reserved: /apps/${RESERVED_SLUG} is a page.`,
    });
    expect(fieldOf(redrawn, "slug").error).not.toContain(`"slug"`);
    // …and nothing else is marked: one violation, one error.
    expect(fieldOf(redrawn, "endpoint")).toEqual({ invalid: false, error: null });
    expect(formAlert(redrawn)).toBeNull();

    // The rest of the form echoed back, so nothing the owner typed has to be retyped.
    const [echoed] = formsPostingTo(redrawn, paths.appCreate);
    expect(echoed.slug).toBe(RESERVED_SLUG);
    expect(echoed.endpoint).toBe(endpoint);
    expect(echoed.name).toBe("Reserved");

    // NOTHING CREATED: a refused create is not a create (§8).
    expect(await slugsOf()).not.toContain(RESERVED_SLUG);

    // The other three slug refusals §13's boards draw, each as the page yields it from the
    // OP's own message — derived here rather than transcribed, because server/dev/fixtures'
    // `slugReserved`, `slugInvalid` and `errors` carry exactly these strings.
    for (const [typed, sentence] of [
      [PMCP_SLUG, `The slug "${PMCP_SLUG}" is reserved for the builtin admin app.`],
      ["News_Feed", "Is not a valid slug."],
      ["news", "Already exists in this namespace."],
    ] as const) {
      const answered = await submitNewApp({ kind: "tunnel", name: "Board", slug: typed });
      expect(answered.status, typed).toBe(400);
      expect(fieldOf(await answered.text(), "slug").error, typed).toBe(sentence);
    }

    // THE TWIN: the same form, one legal slug on, lands on the created card.
    const slug = uniqueSlug("proxied");
    const created = await submitNewApp({ kind: "proxy", authMode: "headers", name: "Docs", slug, endpoint });
    expect(created.status).toBe(200);
    const card = textOf(await created.text());
    expect(card).toContain("App created");
    expect(card).toContain(slug);
    const stored = (await ops.app_get.handler(world.ns.owner.userId, { slug })) as {
      app: { endpoint: string; auth: string };
    };
    expect(stored.app).toMatchObject({ endpoint, auth: "headers" });
  });

  it("§13/§8 · a proxied endpoint must be an https:// URL — http:// only for localhost, 127.0.0.1 and [::1]: `not-a-url`, `mcp.example.com` and `http://mcp.example.com/mcp` are refused under Endpoint on the page and by app_create alike, `http://localhost:3000/mcp` and `https://mcp.example.com/mcp` pass (the twins), and app_update applies the same rule to a stored app", async () => {
    const ownerId = world.ns.owner.userId;

    for (const endpoint of ["not-a-url", "mcp.example.com", "http://mcp.example.com/mcp"]) {
      const slug = uniqueSlug("bad");
      const refused = await submitNewApp({ kind: "proxy", authMode: "headers", name: "Bad", slug, endpoint });
      expect(refused.status, endpoint).toBe(400);
      expect(fieldOf(await refused.text(), "endpoint"), endpoint).toEqual({
        invalid: true,
        error: ENDPOINT_SHOWN,
      });
      // The rule is the OP's, not the page's — the same string refused at the owner's
      // trust boundary, and nothing stored.
      await expect(
        ops.app_create.handler(ownerId, { slug, kind: "proxy", endpoint }),
        endpoint,
      ).rejects.toThrow(ENDPOINT_REASON);
      expect(await slugsOf(), endpoint).not.toContain(slug);
    }

    // THE TWINS: loopback over http and a remote over https both pass, through the page.
    for (const endpoint of ["http://localhost:3000/mcp", "https://mcp.example.com/mcp"]) {
      const slug = uniqueSlug("ok");
      const created = await submitNewApp({ kind: "proxy", authMode: "headers", name: "Fine", slug, endpoint });
      expect(created.status, endpoint).toBe(200);
      const stored = (await ops.app_get.handler(ownerId, { slug })) as { app: { endpoint: string } };
      expect(stored.app.endpoint, endpoint).toBe(endpoint);
    }

    // §8 names three loopback hosts and the form has one Endpoint box, so the other two
    // spellings are walked at the op.
    for (const endpoint of ["http://127.0.0.1:3000/mcp", "http://[::1]:3000/mcp"]) {
      await expect(
        ops.app_create.handler(ownerId, { slug: uniqueSlug("loop"), kind: "proxy", endpoint }),
        endpoint,
      ).resolves.toBeDefined();
    }

    // app_update applies the same rule to a stored app — at update as at create (§8).
    const slug = uniqueSlug("stored");
    await ops.app_create.handler(ownerId, { slug, kind: "proxy", endpoint: "https://mcp.example.com/mcp" });
    await expect(
      ops.app_update.handler(ownerId, { slug, endpoint: "http://mcp.example.com/mcp" }),
    ).rejects.toThrow(ENDPOINT_REASON);
    await expect(
      ops.app_update.handler(ownerId, { slug, endpoint: "https://mcp.example.com/v2" }),
    ).resolves.toBeDefined();
    const after = (await ops.app_get.handler(ownerId, { slug })) as { app: { endpoint: string } };
    expect(after.app.endpoint).toBe("https://mcp.example.com/v2");
  });

  it("§13 · two violations render two field errors at once — a reserved-route slug beside a bad endpoint, both inputs aria-invalid — and a single violation renders exactly one (the twin); a violation naming no control of the form is the whole-form message", async () => {
    const refused = await submitNewApp({
      kind: "proxy",
      authMode: "headers",
      name: "Both",
      slug: RESERVED_SLUG,
      endpoint: "mcp.example.com",
    });
    expect(refused.status).toBe(400);
    const redrawn = await refused.text();
    expect(fieldOf(redrawn, "slug")).toEqual({
      invalid: true,
      error: `The slug "${RESERVED_SLUG}" is reserved: /apps/${RESERVED_SLUG} is a page.`,
    });
    expect(fieldOf(redrawn, "endpoint")).toEqual({ invalid: true, error: ENDPOINT_SHOWN });
    expect(formAlert(redrawn)).toBeNull();

    // THE TWIN: one violation is one error, and the other control comes back clean.
    const single = await submitNewApp({
      kind: "proxy",
      authMode: "headers",
      name: "One",
      slug: uniqueSlug("one"),
      endpoint: "mcp.example.com",
    });
    const only = await single.text();
    expect(fieldOf(only, "endpoint")).toEqual({ invalid: true, error: ENDPOINT_SHOWN });
    expect(fieldOf(only, "slug")).toEqual({ invalid: false, error: null });
    expect(formAlert(only)).toBeNull();

    // A violation naming NO control of the form is the whole-form message. `roles` is such
    // a field — app_create declares it and the add-app form draws no control for it, which
    // is walked here rather than assumed — so its violation can only be reported whole-form.
    const [drawn] = formsPostingTo(await page(paths.appNew), paths.appCreate);
    expect(Object.keys(drawn)).not.toContain("roles");
    await expect(
      ops.app_create.handler(world.ns.owner.userId, {
        slug: uniqueSlug("roles"),
        kind: "proxy",
        endpoint: "https://mcp.example.com/mcp",
        roles: { all: [] },
      }),
      // The sentence the whole-form alert would draw from this is
      // `Role name "all" is reserved.` — server/dev/fixtures' `errors.form`.
    ).rejects.toMatchObject({
      // On the error object, never on the wire's `data` (§7: -32003's alone).
      violations: [{ field: "roles", reason: `"roles" role name "all" is reserved` }],
    });
  });

  it("§13 · a proxied OAuth create answers 200 with the connecting page — \"Connecting to <name>…\", the ten-minute sentence, \"Continue to <name>\" linking the provider's authorize URL (a state row minted for this session) and \"Not now\" linking the app's Overview pane — never the 303 the app page's own Connect keeps · a create whose discovery fails lands on that Overview pane with the connect notice, the app created (the twin)", async () => {
    const scenario: UpstreamScenario = {
      id: uniqueSlug("up"),
      mode: { kind: "ok" },
      as: { id: uniqueSlug("as") } as AsScenario,
    };
    const slug = uniqueSlug("linear");
    const answered = await submitNewApp({
      kind: "proxy",
      authMode: "oauth",
      name: "Linear",
      slug,
      endpoint: upstreamUrlFor(scenario),
    });
    // A 200 RENDER, never a redirect: a page cannot open a tab without a script and a
    // create must not depend on one (decision 30), so the owner is handed a link.
    expect(answered.status).toBe(200);
    const html = await answered.text();
    const text = textOf(html);
    expect(text).toContain("Connecting to Linear…");
    expect(text).toContain("Finish signing in at Linear — this link expires in about 10 minutes.");

    const links = linksOf(html);
    expect(links["Not now"]).toBe(paths.appPane(slug, "overview"));
    const authorize = new URL(links["Continue to Linear"] ?? "", ORIGIN);
    expect(authorize.host).toBe(AS_HOST);
    // The state the link carries is a row minted for THIS session, alive for §7's window.
    const state = authorize.searchParams.get("state") ?? "";
    const row = await (env.DB as D1Like)
      .prepare(`SELECT session_id, expires_at FROM upstream_oauth_state WHERE state = ?`)
      .bind(state)
      .first<{ session_id: string; expires_at: number }>();
    expect(row?.session_id).toBe(world.sessionId);
    expect(row?.expires_at).toBeGreaterThan(Date.now());

    // Never the 303 the app page's own Connect keeps — that route is untouched.
    const csrf = csrfOf(await page(paths.apps));
    expect((await post(paths.appConnect(slug), {}, { csrf })).status).toBe(303);

    // THE TWIN: discovery fails and the app still exists, so the landing is its own
    // Overview pane. The scenario names no authorization server at all, so both
    // well-known documents answer 404 over an https:// endpoint the URL rule accepts.
    const blind: UpstreamScenario = { id: uniqueSlug("up"), mode: { kind: "ok" } };
    const other = uniqueSlug("blind");
    const failed = await submitNewApp({
      kind: "proxy",
      authMode: "oauth",
      name: "Blind",
      slug: other,
      endpoint: upstreamUrlFor(blind),
    });
    expect(failed.status).toBe(303);
    const landing = new URL(failed.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(paths.appPane(other, "overview"));
    expect(landing.searchParams.get("failed")).toBe("connect");
    await expect(ops.app_get.handler(world.ns.owner.userId, { slug: other })).resolves.toBeDefined();
  });

  it("§13/§8 · a blank Name is not sent: the created app's name is its slug, and `name` is not a key the form can error on", async () => {
    const slug = uniqueSlug("unnamed");
    const created = await submitNewApp({ kind: "tunnel", name: "", slug });
    expect(created.status).toBe(200);
    const stored = (await ops.app_get.handler(world.ns.owner.userId, { slug })) as { app: { name: string } };
    expect(stored.app.name).toBe(slug);

    // …and a refusal marks the control it named while Name comes back clean: §8 defaults
    // the field, so no refusal can ever name it (§13 — the form has no Name error).
    const refused = await submitNewApp({ kind: "tunnel", name: "", slug: RESERVED_SLUG });
    const redrawn = await refused.text();
    expect(fieldOf(redrawn, "slug").invalid).toBe(true);
    expect(fieldOf(redrawn, "name")).toEqual({ invalid: false, error: null });
  });
});

describe("§8/§13 · one paging contract, two presentations", () => {
  it("10. §8 · the page's \"N events match\" line is audit.query's `total`, not the rendered row count — they differ whenever a page is not the last one", async () => {
    const filters = { event: "tools/call", app: "news" };
    const first = await page(auditPath({ ...filters, limit: 3, offset: 0 }));
    const truth = await query(env.DB, world.ns.owner.userId, filters as AuditQuery);
    expect(matchedLine(first)).toBe(truth.total);
    // …and the two numbers really do differ on this page, which is what makes the
    // assertion above worth making.
    expect(renderedTools(first).length).toBe(3);
    expect(truth.total).toBeGreaterThan(3);
  });

  it("11. §13 · desktop page numbers and mobile \"Load more\" walk the same offset/limit contract to the same final row set", async () => {
    const filters = { event: "tools/call", app: "news", limit: 4 };
    // Desktop: follow the pager's own next-page links until it stops offering one.
    const desktop: string[] = [];
    let path = auditPath({ ...filters, offset: 0 });
    for (;;) {
      const html = await page(path);
      desktop.push(...renderedTools(html));
      const next = nextPageLink(html);
      if (next === null) break;
      path = next;
    }
    // Mobile: follow "Load more", which widens the limit against the same offset.
    let mobile: string[] = [];
    let mobilePath = auditPath({ ...filters, offset: 0 });
    for (;;) {
      const html = await page(mobilePath);
      mobile = renderedTools(html);
      const more = loadMoreLink(html);
      if (more === null) break;
      mobilePath = more;
    }
    expect(mobile.length).toBeGreaterThan(filters.limit);
    expect(new Set(mobile)).toEqual(new Set(desktop));
    expect(mobile).toEqual(desktop);
  });

  it("12. §13 · Export JSONL emits exactly `total` lines for the current filters", async () => {
    const filters = { event: "tools/call", app: "news" };
    const truth = await query(env.DB, world.ns.owner.userId, filters as AuditQuery);
    const lines = await exportLines({ ...filters, limit: 3, offset: 0 });
    // The page's limit/offset are the PAGE's, never the export's (§8).
    expect(lines.length).toBe(truth.total);
  });

  it("13. §13 · the export applies the page's filters verbatim — a filtered export is a strict subset of the unfiltered one over the same seed", async () => {
    const all = await exportLines({});
    const filtered = await exportLines({ session: SHARED_SESSION });
    const idsOf = (lines: AuditRow[]) => new Set(lines.map((row) => row.id));
    const everything = idsOf(all);
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(all.length);
    for (const row of filtered) expect(everything.has(row.id)).toBe(true);
    for (const row of filtered) expect(row.client?.sessionId).toBe(SHARED_SESSION);
  });

  it("14. §15 · an exported row carries its recorded bodies post-redaction, with stubs rendered as typed placeholders · never the bytes a blob stub stands for", async () => {
    const [row] = await exportLines({ tool: `${TOOL_PREFIX}1` });
    expect(row.args).toEqual({ q: "term", token: "‹redacted›" });
    // The stub is what was stored, and it is all that leaves: a type and a size.
    expect(row.result).toEqual({ content: [{ stub: "blob", contentType: "image/png", bytes: 4_200_000 }] });
    // The same row on the page, expanded: a typed size placeholder, never bytes.
    const expanded = await page(auditPath({ tool: `${TOOL_PREFIX}1`, expand: row.id }));
    expect(expanded).toContain("‹blob image/png");
    expect(expanded).toContain("‹redacted›");
  });

  it("15. §13 · a row's client session id links back to this same view as ?session=… and that link returns exactly the rows sharing the session", async () => {
    const [row] = await exportLines({ tool: `${TOOL_PREFIX}0` });
    // Expanded from the UNFILTERED view, because the link carries the page's other filters
    // forward: what is being pinned is that the session narrows the view, not that a tool
    // filter survives it.
    const expanded = await page(auditPath({ expand: row.id }));
    const link = sessionLink(expanded);
    expect(link, "the expanded row rendered no session link").not.toBeNull();
    expect(new URL(link ?? "", ORIGIN).searchParams.get("session")).toBe(SHARED_SESSION);
    const shared = await page(link ?? "");
    const truth = await query(env.DB, world.ns.owner.userId, { session: SHARED_SESSION });
    expect(matchedLine(shared)).toBe(truth.total);
    expect(new Set(renderedTools(shared))).toEqual(
      new Set(truth.rows.map((event) => event.tool).filter((tool): tool is string => tool !== undefined)),
    );
  });

  it("16. §13 · a row's chevron is a link to this same view with ?expand=<id> carrying the page's filters — exactly the rows with something to show draw one, so a bodiless auth row draws none — and the open row's own chevron links back without expand (G1)", async () => {
    const filters = { limit: 50, offset: 0 };
    const truth = await query(env.DB, world.ns.owner.userId, filters as AuditQuery);
    const showable = (row: AuditRow) => Boolean(row.client || row.detail || row.args || row.result);
    // The twin needs a subject: the world's device approval is a fact about a credential
    // and carries no bodies (§15), so it is a row with nothing to expand.
    expect(truth.rows.filter((row) => !showable(row)).map((row) => row.event)).toContain("auth.device_approved");

    // A row draws its chevron twice — the wide row and the compact cell, one per
    // breakpoint (CSS hides the other) — so every count below is per width.
    const closed = expandLinks(await page(auditPath(filters)));
    expect(closed.every((link) => link.label === "Show detail")).toBe(true);
    const ids = closed.map((link) => Number(link.query.get("expand")));
    expect(new Set(ids)).toEqual(new Set(truth.rows.filter(showable).map((row) => row.id)));
    expect(ids.length).toBe(new Set(ids).size * 2);
    for (const link of closed) expect(link.query.get("limit"), "the page's filters ride along").toBe("50");

    // Follow one: that row is open, its own chevron links back without expand (filters
    // kept), and every other chevron still opens its own row.
    const [first] = closed;
    expect(first).toBeDefined();
    const open = expandLinks(await page(first?.href ?? ""));
    const back = open.filter((link) => link.label === "Hide detail");
    expect(back.length).toBe(2);
    for (const link of back) {
      expect(link.query.get("expand")).toBeNull();
      expect(link.query.get("limit")).toBe("50");
    }
    expect(open.filter((link) => link.label === "Show detail").length).toBe(closed.length - 2);
  });

  it("17. §13 · every expandable row's detail is already in the page, hidden unless it is the addressed row (whose summary row is row-open), so the toggle script opens it in place with no reload and keeps ?expand=<id> in the address — a row with nothing to show renders no detail row, and the script rides the page (the twin: scripting off leaves the addressed row the only open one)", async () => {
    const filters = { limit: 50, offset: 0 };
    const truth = await query(env.DB, world.ns.owner.userId, filters as AuditQuery);
    const showable = (row: AuditRow) => Boolean(row.client || row.detail || row.args || row.result);
    // The detail row as rendered; group 1 is present exactly when the row is hidden.
    const detailRow = (html: string, id: number) => new RegExp(`<tr class="row-detail" id="detail-${id}"( hidden[^>]*)?>`).exec(html);

    const closed = await page(auditPath(filters));
    expect(closed, "the toggle script rides the page").toContain('closest("a.row-toggle")');
    expect(closed).not.toContain('class="row-open"');
    for (const row of truth.rows) {
      const found = detailRow(closed, row.id);
      if (!showable(row)) {
        expect(found, `bodiless row ${row.id} rendered a detail row`).toBeNull();
        continue;
      }
      expect(found, `row ${row.id} has no detail row in the page`).not.toBeNull();
      expect(found?.[1], `row ${row.id} is open on a page that addresses none`).toBeDefined();
    }

    const [addressed] = truth.rows.filter(showable);
    expect(addressed).toBeDefined();
    const open = await page(auditPath({ ...filters, expand: addressed?.id ?? 0 }));
    expect(open.match(/class="row-open"/g)?.length, "exactly one summary row is open").toBe(1);
    for (const row of truth.rows.filter(showable)) {
      const found = detailRow(open, row.id);
      expect(found, `row ${row.id} lost its detail row`).not.toBeNull();
      if (row.id === addressed?.id) expect(found?.[1], "the addressed row is hidden").toBeUndefined();
      else expect(found?.[1], `row ${row.id} is open beside the addressed one`).toBeDefined();
    }
  });

  // Row 18 moved to its own describe below (§13/§22 · past the scan ceiling): it needs a
  // window of 1,001 rows, and seeding that many inline here would move the counts every
  // other row in this describe reads off `query(env.DB, …)`. Title kept byte-identical.
});

describe("§13/§15 · /audit's expanded row — the bodies, the stubs, and the sentence for their absence", () => {
  // Six rows of this describe's own, written through `audit.record` like every other row
  // in the file, each under a tool name nothing else uses so `?tool=` addresses exactly
  // one. The seeded world supplies both twins: `walk-tool-1` carries bodies and a blob
  // stub, `walk-tool-0` is a refusal that carries them too.
  //
  // The two apps are the seeded world's own, and which sentence a row gets is §15's
  // default for the app's KIND: `notion` is proxied (log_bodies off), `news` tunneled
  // (on). Both defaults are read back off `app_list` inside the cases rather than
  // assumed, because "the app's setting" is the whole subject here.
  const OFF_APP = "notion";
  const ON_APP = "news";
  const CLIENT = { name: "walker", version: "1.0", sessionId: "sess-off" };

  beforeAll(async () => {
    const call = {
      ownerId: world.ns.owner.userId,
      principal: "agent:agent",
      event: "tools/call",
      outcome: "ok",
      durationMs: 12,
    };
    await record(env.DB, { ...call, app: OFF_APP, tool: "off-tool", client: CLIENT });
    // The same row without a client: the sentence is then the whole panel, which is what
    // makes "expandable for that sentence alone" a claim about the row being expandable
    // at all rather than about the client line it usually sits beside.
    await record(env.DB, { ...call, app: OFF_APP, tool: "off-only-tool" });
    // A refusal on the app whose logging is OFF — the refusal is the reason whatever the
    // app's setting, which is only checkable when the two answers differ.
    await record(env.DB, { ...call, app: OFF_APP, tool: "refused-tool", outcome: "-32001", client: CLIENT });
    await record(env.DB, { ...call, app: ON_APP, tool: "unrecorded-tool", client: CLIENT });
    // An app that is gone: no `app_list` row at all, so there is no setting to read.
    await record(env.DB, { ...call, app: "vanished", tool: "vanished-tool", client: CLIENT });
    // Over the 16 KiB cap, so what is STORED is one oversize stub — the page never sees
    // the string of x's, because the hub never kept it (§15).
    await record(env.DB, { ...call, app: ON_APP, tool: "oversize-tool", client: CLIENT, args: { blob: "x".repeat(20_000) } });
  });

  /** The rendered text of ONE row's detail panel, read from the open row only: every
   *  expandable row's detail rides the page, and the open one is the one without `hidden`
   *  (the same shape `sessionLink` reads). */
  function detailText(html: string, id: number): string {
    const open = new RegExp(`<tr class="row-detail" id="detail-${id}">([\\s\\S]*?)</tr>`).exec(html);
    expect(open, `row ${id} is not the open row on this page`).not.toBeNull();
    return textOf(open?.[1] ?? "");
  }

  /** One row by the tool name it was recorded under — the id is the ledger's, never a
   *  guess, so `?expand=` addresses the row this case is about. */
  async function rowOf(tool: string): Promise<AuditRow> {
    const lines = await exportLines({ tool });
    expect(lines.length, `no ledger row for tool "${tool}"`).toBe(1);
    return lines[0] as AuditRow;
  }

  /** §15's `log_bodies` as the hub reports it, through the same read the loader makes. */
  async function logBodiesOf(slug: string): Promise<boolean | undefined> {
    const { apps } = (await ops.app_list.handler(world.ns.owner.userId, {})) as {
      apps: { slug: string; logBodies: boolean }[];
    };
    return apps.find((app) => app.slug === slug)?.logBodies;
  }

  it("a dispatched tools/call row with no bodies on an app whose body logging is off opens to \"Call bodies aren't recorded for this app (body logging is off).\" beside its client line — expandable for that sentence alone · a row with recorded bodies shows them and never that sentence (the twin)", async () => {
    expect(await logBodiesOf(OFF_APP), "the proxied app's §15 default is off").toBe(false);
    const row = await rowOf("off-tool");
    expect(row.args, "the row under test recorded an args body").toBeUndefined();
    expect(row.result, "the row under test recorded a result body").toBeUndefined();

    const detail = detailText(await page(auditPath({ tool: "off-tool", expand: row.id })), row.id);
    expect(detail).toContain("Call bodies aren't recorded for this app (body logging is off).");
    expect(detail, "the sentence stands beside the client line, not instead of it").toContain(CLIENT.sessionId);

    // Expandable for that sentence alone: the clientless row has nothing else to show, and
    // still draws a chevron and carries a detail panel that is exactly the sentence.
    const alone = await rowOf("off-only-tool");
    const closed = await page(auditPath({ tool: "off-only-tool" }));
    expect(expandLinks(closed).map((link) => link.query.get("expand"))).toContain(String(alone.id));
    const solo = await page(auditPath({ tool: "off-only-tool", expand: alone.id }));
    expect(detailText(solo, alone.id)).toBe(
      "Event detail Call bodies aren't recorded for this app (body logging is off).",
    );

    // The twin: a row that DID record bodies shows them and says nothing about logging.
    const bodied = await rowOf(`${TOOL_PREFIX}1`);
    const shown = detailText(await page(auditPath({ tool: `${TOOL_PREFIX}1`, expand: bodied.id })), bodied.id);
    expect(shown).toContain("Arguments:");
    expect(shown).not.toContain("body logging is off");
  });

  it("a refused call (-32001) with no bodies opens to \"Refused before the call was made, so there are no bodies to show.\" — never the bodies-off sentence, whatever the app's setting · the seed's refusal that does carry bodies shows them and no sentence (the twin)", async () => {
    const row = await rowOf("refused-tool");
    expect(row.outcome).toBe("-32001");
    // The app's logging is off, so the two reasons disagree — and the refusal wins.
    expect(await logBodiesOf(OFF_APP)).toBe(false);
    const detail = detailText(await page(auditPath({ tool: "refused-tool", expand: row.id })), row.id);
    expect(detail).toContain("Refused before the call was made, so there are no bodies to show.");
    expect(detail).not.toContain("body logging is off");

    // The twin: the seed's own -32001 row carries bodies, so it shows them and explains
    // nothing — the sentence is for a row with no bodies, not for every refusal.
    const seeded = await rowOf(`${TOOL_PREFIX}0`);
    expect(seeded.outcome).toBe("-32001");
    const shown = detailText(await page(auditPath({ tool: `${TOOL_PREFIX}0`, expand: seeded.id })), seeded.id);
    expect(shown).toContain("Arguments:");
    expect(shown).not.toContain("there are no bodies to show");
  });

  it("a dispatched tools/call row with no bodies on an app whose body logging is on opens to \"No bodies were recorded for this call.\" — a row from before logging was switched on, or from an app that is gone, is explained rather than left blank", async () => {
    expect(await logBodiesOf(ON_APP), "the tunneled app's §15 default is on").toBe(true);
    const row = await rowOf("unrecorded-tool");
    const detail = detailText(await page(auditPath({ tool: "unrecorded-tool", expand: row.id })), row.id);
    expect(detail).toContain("No bodies were recorded for this call.");
    expect(detail).not.toContain("body logging is off");

    // The other half of "otherwise": an app that is gone has no setting to read, and the
    // panel is still a sentence rather than a blank.
    expect(await logBodiesOf("vanished"), "the vanished app is not in app_list").toBeUndefined();
    const gone = await rowOf("vanished-tool");
    expect(detailText(await page(auditPath({ tool: "vanished-tool", expand: gone.id })), gone.id)).toContain(
      "No bodies were recorded for this call.",
    );
  });

  it("an over-cap body is stored as one oversize stub and reaches the page through the loader as ‹oversize · N KB› — KB under a megabyte, MB with one decimal above — and the export carries the same stub, never the bytes", async () => {
    const row = await rowOf("oversize-tool");
    const args = row.args as { stub?: string; bytes?: number } | undefined;
    expect(args?.stub, "the over-cap body was not replaced whole").toBe("oversize");
    expect(args?.bytes).toBeGreaterThan(16 * 1024);
    expect(JSON.stringify(row), "the export carries the bytes the cap refused").not.toContain("xxxxxxxx");

    const expanded = await page(auditPath({ tool: "oversize-tool", expand: row.id }));
    expect(detailText(expanded, row.id)).toContain("‹oversize · 20 KB›");
    expect(expanded).not.toContain("xxxxxxxx");

    // Above a megabyte the same placeholder reads in MB with one decimal — the seed's
    // 4,200,000-byte image block, which is the other side of the same formatter.
    const bodied = await rowOf(`${TOOL_PREFIX}1`);
    expect(detailText(await page(auditPath({ tool: `${TOOL_PREFIX}1`, expand: bodied.id })), bodied.id)).toContain(
      "‹blob image/png · 4.0 MB›",
    );
  });

  it("the summary row carries id=\"event-<id>\" and an opening chevron's link ends in #event-<id>, so the scripting-off reload lands on the row it opened · the open row's closing link carries no fragment (the twin)", async () => {
    const row = await rowOf("unrecorded-tool");
    const closed = await page(auditPath({ tool: "unrecorded-tool" }));
    expect(closed, "the summary row carries no anchor").toMatch(new RegExp(`<tr[^>]* id="event-${row.id}"`));

    // The opening chevron: the same URL the closed page would be reloaded with, plus the
    // fragment that scrolls the reload to the row it opened.
    const opening = expandLinks(closed).filter((link) => link.query.get("expand") === String(row.id));
    expect(opening.length, "one chevron per breakpoint").toBe(2);
    for (const link of opening) expect(new URL(link.href, ORIGIN).hash).toBe(`#event-${row.id}`);

    // Follow it as a browser with no script does: the row is open, still anchored, and its
    // own chevron — which closes the row — carries no fragment to scroll to.
    const open = await page(opening[0]?.href ?? "");
    expect(open).toMatch(new RegExp(`<tr class="row-open" id="event-${row.id}"`));
    const back = expandLinks(open).filter((link) => link.label === "Hide detail");
    expect(back.length).toBe(2);
    for (const link of back) {
      expect(link.query.get("expand")).toBeNull();
      expect(new URL(link.href, ORIGIN).hash).toBe("");
    }
  });
});

describe(`§13 · /audit's filter row — the window it names and the window it empties`, () => {
  // Rows first (§9 rule 1), bodies written against the page as it was: the filter row had
  // no way to apply with scripting off, its window was a readonly box over a hidden epoch
  // pair, and an empty window drew 24 flat bars. The helpers below ARE the scripting-off
  // browser, which is why this describe reads the form's markup the rest of the file does
  // not: a submit control hidden at the breakpoint is the defect §9 rule 4(b) names.

  /** #audit-filters exactly as a browser submits it: method and action off the start tag,
   *  params from the form's own named controls in document order (a select contributes its
   *  selected option, else its first) plus the pager's `form="audit-filters"` limit, and
   *  whether a submit control sits in the form OUTSIDE every wide-only subtree (non-greedy;
   *  none nests a div today). */
  function formSubmission(html: string): {
    method: string;
    action: string;
    params: URLSearchParams;
    submitOutsideWideOnly: boolean;
  } {
    const form = /<form id="audit-filters"([^>]*)>([\s\S]*?)<\/form>/.exec(html);
    expect(form, "the page rendered no #audit-filters form").not.toBeNull();
    const [, attrs, body] = form ?? ["", "", ""];
    const params = new URLSearchParams();
    const selectValue = (options: string): string => {
      const all = [...options.matchAll(/<option\b([^>]*)>/g)].map((o) => o[1]);
      const picked = all.find((o) => /\bselected\b/.test(o)) ?? all[0] ?? "";
      return decodeEntities(attributeOf(picked, "value") ?? "");
    };
    for (const control of body.matchAll(/<input\b([^>]*)>|<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const attributes = control[1] ?? control[2];
      const name = attributeOf(attributes, "name");
      if (name === null || /type="(submit|button)"/.test(attributes)) continue;
      params.append(
        name,
        control[1] === undefined ? selectValue(control[3]) : decodeEntities(attributeOf(attributes, "value") ?? ""),
      );
    }
    for (const outside of html.matchAll(/<select\b([^>]*form="audit-filters"[^>]*)>([\s\S]*?)<\/select>/g)) {
      params.append(attributeOf(outside[1], "name") ?? "", selectValue(outside[2]));
    }
    const submit = /<button type="submit"/;
    const withoutWideOnly = body.replace(/<div class="[^"]*\bwide-only\b[^"]*"[^>]*>[\s\S]*?<\/div>/g, "");
    return {
      method: (attributeOf(attrs, "method") ?? "").toLowerCase(),
      action: decodeEntities(attributeOf(attrs, "action") ?? ""),
      params,
      submitOutsideWideOnly: submit.test(body) && submit.test(withoutWideOnly),
    };
  }

  /** The four range segments: each key's href and whether it is the current one. */
  function segments(html: string): Record<string, { href: string; current: boolean }> {
    const block = /<div class="segmented">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? "";
    const out: Record<string, { href: string; current: boolean }> = {};
    for (const a of block.matchAll(/<a href="([^"]*)"([^>]*)>(\w+)<\/a>/g)) {
      out[a[3]] = { href: decodeEntities(a[1]), current: /aria-current="page"/.test(a[2]) };
    }
    return out;
  }

  /** The two date inputs' `value` attributes, by name — absent when the input is not drawn. */
  function dateInputs(html: string): Partial<Record<"since" | "until", string>> {
    const out: Partial<Record<"since" | "until", string>> = {};
    for (const input of html.matchAll(/<input type="date" name="(since|until)"([^>]*)>/g)) {
      out[input[1] as "since" | "until"] = attributeOf(input[2], "value") ?? "";
    }
    return out;
  }

  /** The UTC day every seeded row is stamped on — asserted, so a midnight straddle fails
   *  here by name rather than as a wrong count further down. */
  async function seededDay(): Promise<{ day: string; total: number }> {
    const truth = await query(env.DB, world.ns.owner.userId, {});
    const stamps = truth.rows.map((row) => row.ts);
    const day = new Date(Math.min(...stamps)).toISOString().slice(0, 10);
    expect(new Date(Math.max(...stamps)).toISOString().slice(0, 10), "the seed straddles midnight").toBe(day);
    return { day, total: truth.total };
  }

  const nextDay = (day: string): string => new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);

  // plan row 1. §9 rule 4(b)'s discharge for #audit-filters: the form is replayed exactly as
  // a browser submits it, so the submit control has to exist outside every wide-only subtree
  // and the tool the owner typed has to reach query(env.DB, …) over the window that
  // submission names — the untouched replay, which is what a select's onchange sends, is the
  // twin that must come back with the default window intact. The wide-only read is that
  // discharge and not the header's "layout": a submit control hidden at the breakpoint is
  // the defect rule 4(b) names, so the header's one exception is not being spent twice.
  it(`§13 · with scripting off the filter row still applies: #audit-filters renders a submit control that sits in no wide-only subtree, and its own method, action and fields replayed as a browser submits them (§9 rule 4(b), no onchange) return exactly the rows query(env.DB, …) holds for the tool the owner typed over the window that submission names, with since and until each submitted once (the hidden pair is gone, so the value the owner set is the value the loader reads) · the same form replayed untouched returns the default 24h window unchanged — the same seeded rows, the same tool box, 24h still current, carried by the form's own hidden range field — which is also exactly what a select's onchange submits (the twin)`, async () => {
    const ownerId = world.ns.owner.userId;
    const form = formSubmission(await page(paths.audit));
    expect(form.submitOutsideWideOnly, "no submit control outside every wide-only subtree").toBe(true);
    expect(form.method).toBe("get");
    expect(form.action).toBe(paths.audit);
    // The pair the owner can set, each carried ONCE: a second control of the same name
    // would be the one URLSearchParams.get returns, and the owner's value would never take.
    expect(form.params.getAll("since")).toHaveLength(1);
    expect(form.params.getAll("until")).toHaveLength(1);

    // The owner types a tool and presses Apply (or Return): the form, its fields, nothing else.
    const typed = new URLSearchParams(form.params);
    const tool = `${TOOL_PREFIX}3`;
    typed.set("tool", tool);
    const applied = await page(`${form.action}?${typed.toString()}`);
    const truth = await query(env.DB, ownerId, { tool });
    expect(truth.total).toBeGreaterThan(0);
    expect(matchedLine(applied)).toBe(truth.total);
    expect(renderedTools(applied)).toEqual(truth.rows.map((row) => row.tool));
    expect(formSubmission(applied).params.get("tool")).toBe(tool);

    // The twin: the same form replayed untouched — which is what a select's onchange sends
    // minus nothing — is the default window again, not a custom one and not an empty one.
    const replayed = await page(`${form.action}?${form.params.toString()}`);
    const everything = await query(env.DB, ownerId, {});
    expect(matchedLine(replayed)).toBe(everything.total);
    expect(renderedTools(replayed)).toEqual(renderedTools(await page(paths.audit)));
    const again = formSubmission(replayed);
    expect(again.params.get("tool")).toBe("");
    expect(again.params.get("range")).toBe("24h");
    expect(segments(replayed)["24h"]?.current).toBe(true);
  });

  // plan row 2. The two carriers of the window, pinned apart: a typed pair is whole days
  // echoed back as the two value attributes with no segment current, and a preset arrives as
  // the segment's own epoch-ms link with both inputs empty beside a hidden range. Every
  // seeded row is stamped ≈now, so the preset's previous window is the empty one. Carry row
  // 3's min(ts)/max(ts) guard into this body too — "<the seed's day>" is only one day while
  // every seeded row shares it.
  it(`§13 · the range inputs are named since/until and take a day, not epoch ms: a submission carrying since=<the seed's day>&until=<the same day> renders that day's rows, echoes both days back as the two value attributes, and marks no segment aria-current="page" — a custom window has no current preset · the 24h segment's own epoch-ms link over the same seed marks 24h current, renders both date inputs empty beside a hidden range=24h, and reads "No comparison available", every row being stamped now and a preset's previous window lying one span further back (the preset twin)`, async () => {
    const { day, total } = await seededDay();
    const custom = await page(auditPath({ since: day, until: day }));
    expect(matchedLine(custom)).toBe(total);
    expect(dateInputs(custom)).toEqual({ since: day, until: day });
    expect(Object.values(segments(custom)).some((s) => s.current), "a custom window marked a preset current").toBe(false);

    // The preset twin, reached the way the page offers it: the segment's own link.
    const link = segments(custom)["24h"]?.href;
    expect(link, "the custom page drew no 24h segment").toBeDefined();
    const preset = await page(link ?? "");
    expect(segments(preset)["24h"]?.current).toBe(true);
    expect(dateInputs(preset)).toEqual({ since: "", until: "" });
    expect(/<input type="hidden" name="range" value="24h"/.test(preset)).toBe(true);
    expect(matchedLine(preset)).toBe(total);
    expect(textOf(preset)).toContain("No comparison available");
  });

  // plan row 3. G50: the empty histogram is one early return, so it must co-occur with the
  // table's own empty line and never the reverse. The window is the UTC day AFTER the
  // ledger's, derived from the rows themselves so a midnight straddle fails by name; the
  // seeded day is the twin that draws bars, an axis and no comparison at all.
  it(`§13 · a window with nothing in it draws the empty histogram, not 24 flat bars: over the UTC day AFTER the ledger's own — the case derives that day from the rows and asserts min(ts) and max(ts) share it, so a midnight straddle fails by name — /audit renders "No events in this window." with no day axis AND the table's "No events in this range", and, that day being the previous window, an events tile reading "-100% vs previous period" · the seeded day itself draws bars, a day axis and "No comparison available", its own previous window being empty (the twin)`, async () => {
    const { day } = await seededDay();
    const after = nextDay(day);
    const empty = await page(auditPath({ since: after, until: after }));
    expect(matchedLine(empty)).toBe(0);
    expect(empty).toContain("No events in this window.");
    expect(empty).not.toContain('class="chart-axis"');
    // A bar is `chart-bar` or `chart-bar chart-bar--peak`; their container is `chart-bars`.
    expect(empty).not.toMatch(/class="chart-bar[" ]/);
    expect(empty).toContain("No events in this range");
    // The day before an empty day is the seeded one, so the comparison is a real -100%.
    expect(textOf(empty)).toContain("-100% vs previous period");

    // The twin: the seeded day draws, and its own previous day has nothing to compare to.
    const drawn = await page(auditPath({ since: day, until: day }));
    expect(drawn).toMatch(/class="chart-bar[" ]/);
    expect(drawn).toContain('class="chart-axis"');
    expect(textOf(drawn)).toContain("No comparison available");
  });
});

describe("§13/§22 · past the scan ceiling", () => {
  // One app and one principal vocabulary, apart from every other describe's own, so this
  // window is addressable by app filter alone. 1,001 rows: one past model.ts's
  // AUDIT_SCAN_ROWS (1000) — the least that flips `scanCeiling` from null to the constant.
  const CEILING_APP = "walk-ceiling";
  const CEILING_ROWS = 1001;
  const OLDEST_ONLY_PRINCIPAL = "agent:walk-ceiling-oldest";
  const NEWEST_PRINCIPAL = "agent:walk-ceiling-newest";

  beforeAll(async () => {
    const ownerId = world.ns.owner.userId;
    const row = (principal: string, at: number) => ({
      ownerId,
      principal,
      event: "tools/call",
      app: CEILING_APP,
      tool: `walk-ceiling-tool-${at}`,
      outcome: "ok",
      durationMs: 5,
    });
    // audit.query orders `ts DESC, id DESC` (audit.ts) — id is insertion order, so
    // whatever ties back-to-back `Date.now()` writes draw on `ts`, id alone decides
    // "newest". Written FIRST, this row holds the lowest id of the batch and of the
    // whole namespace at write time, so it ranks last among every scan that follows.
    await record(env.DB, row(OLDEST_ONLY_PRINCIPAL, 0));
    for (let at = 1; at < CEILING_ROWS - 1; at++) await record(env.DB, row("agent:walk-ceiling", at));
    // Written LAST: the highest id in the whole namespace, so it ranks first in every scan.
    await record(env.DB, row(NEWEST_PRINCIPAL, CEILING_ROWS - 1));
  });

  /** One tile's hint text, read off its own `stat-hint` div — never the whole page's text,
   *  so a phrase that landed on the wrong tile fails by name. */
  function hintOf(html: string, label: string): string {
    const found = new RegExp(`<div class="stat-label">${label}</div>[\\s\\S]*?<div class="stat-hint">\\s*([^<]*?)\\s*</div>`).exec(html);
    expect(found, `no "${label}" tile on the page`).not.toBeNull();
    return found?.[1] ?? "";
  }

  it("18. §13 · past the scan ceiling the per-row tiles and the chart say \"over the newest 1,000\" while the Events count stays audit_query's exact total, and the filter selects list only what the newest 1,000 rows mention · a window under the ceiling carries no such label (the twin)", async () => {
    const over = await page(auditPath({ app: CEILING_APP, limit: 50 }));
    // The Events count is exact — audit_query's `total` for this app, all 1,001 of them —
    // while everything per-row is capped at the newest 1,000 of the same window.
    expect(matchedLine(over)).toBe(CEILING_ROWS);

    expect(hintOf(over, "Tool calls")).toContain("over the newest 1,000");
    expect(hintOf(over, "Denied")).toContain("over the newest 1,000");
    expect(hintOf(over, "Median latency")).toContain("over the newest 1,000");
    expect(over).toContain("buckets · over the newest 1,000");
    expect(over).toContain("Events per day · over the newest 1,000");

    // The selects' scan claim: `options` is read off the newest 1,000 rows of the WHOLE
    // namespace, unfiltered — so the oldest-only principal above is excluded from it and
    // the newest-row principal is present, independent of this page's own app filter.
    const principalSelect = /<select name="principal"[^>]*>([\s\S]*?)<\/select>/.exec(over)?.[1] ?? "";
    expect(principalSelect).not.toContain(OLDEST_ONLY_PRINCIPAL);
    expect(principalSelect).toContain(NEWEST_PRINCIPAL);

    // The twin: the world's ordinary window is far under the ceiling and carries no label.
    const under = await page(auditPath({ app: "news" }));
    expect(matchedLine(under)).toBeLessThan(1000);
    expect(under).not.toContain("over the newest 1,000");
  });
});

describe("§13 · /approvals — deciding a request that is no longer pending", () => {
  // G52 (2026-09-03): the lost race — a request decided or expired between the page
  // render and the click — landed as a red "Approval decide failed" through the generic
  // dispatch. §13 now pins the calm answer. approval_decide refuses every non-decidable
  // id with one message on purpose (§7's probe rule), so the tone is keyed on the op.
  it(`§13 · deciding an approval that is no longer pending lands back on /approvals with the warning "That request is no longer pending." — never a red "failed" notice — · deciding a pending one lands with the success notice (the twin)`, async () => {
    // A namespace of its own: the shared world's pending approval is other rows' fixture.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", tokens: [{ as: "news" }] }],
      agents: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] }, tokens: [{ as: "agent" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const id = await openApproval(ns, "news");
    const csrf = csrfOf(await page(paths.approvals, session.cookie));

    // The twin first, because it is what makes the second decision a lost race.
    const decided = await formPost(paths.approvalDecide(id), { csrf, decision: "reject" }, session.cookie);
    expect(decided.status).toBe(303);
    const done = new URL(decided.headers.get("Location") ?? "", ORIGIN);
    expect(done.pathname).toBe(paths.approvals);
    expect(done.searchParams.get("done")).toBe("approval_decide");
    expect(await page(`${done.pathname}${done.search}`, session.cookie)).toContain("alert--success");

    // The lost race: the same decision again, after the row stopped being pending.
    const lost = await formPost(paths.approvalDecide(id), { csrf, decision: "reject" }, session.cookie);
    expect(lost.status).toBe(303);
    const landing = new URL(lost.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(paths.approvals);
    const landed = await page(`${landing.pathname}${landing.search}`, session.cookie);
    expect(textOf(landed)).toContain("That request is no longer pending.");
    expect(landed).toContain("alert--warning");
    expect(landed).not.toContain("alert--danger");
    expect(textOf(landed)).not.toContain("failed");
  });
});

describe("§8 · parity direction B — forms and schemas are one source", () => {
  it("16. §8 · every form rendered on /apps and /approvals names an ops key that exists in admin.ops (no form fronts a tool that is gone)", async () => {
    for (const path of [paths.apps, paths.approvals]) {
      const forms = formsRenderedOn(await page(path));
      expect(forms.length, `${path} rendered no form`).toBeGreaterThan(0);
      for (const form of forms) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) continue;
        expect(Object.prototype.hasOwnProperty.call(ops, form.op), `${path} fronts "${form.op}"`).toBe(true);
      }
    }
  });

  it("17. §8 · each form's field set equals schemaKeysOf(ops[name]) — both sides derived, so a schema change with no form change fails here rather than at a user's keyboard", async () => {
    let checked = 0;
    for (const path of [paths.apps, paths.approvals]) {
      for (const form of formsRenderedOn(await page(path))) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) continue;
        expect(form.fields, `${path} → ${form.op}`).toEqual(schemaKeysOf(ops[form.op]));
        checked += 1;
      }
    }
    expect(checked, "no ops-backed form was checked").toBeGreaterThan(0);
  });

  // 18 was "/settings renders no ops-backed form at all", true only while /settings was one
  // page. §13's Tokens and Connected clients panes front `token_revoke` and
  // `connection_revoke`, so the claim is now PER PANE and lives with the panes: see
  // "every control the /settings panes render is claimed".

  it("19. §8 · every page mutation reaches an ops handler (or better-auth): no page route mutates D1 on its own — the no-web-only-capability invariant, checked by substituting handlers across the ops table rather than by reading web.ts", async () => {
    // Everything the pages have to SAY is read first, while the ops table is still real:
    // the targets they render, and the token they rendered them with. The substitution
    // below replaces the read handlers too, so a page cannot be rendered under it — which
    // is itself the parity invariant showing through (a page has no other source).
    const targets = new Map<string, string>();
    let csrf = "";
    for (const path of [paths.apps, paths.approvals]) {
      const html = await page(path);
      csrf = csrfOf(html);
      for (const form of formsRenderedOn(html)) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) continue;
        targets.set(form.op, actionFor(html, form.op));
      }
    }
    expect(targets.size).toBeGreaterThan(0);
    await withCountedOps([...Object.keys(ops)], async (invocations) => {
      const before = await namespaceShape();
      for (const [op, target] of targets) {
        const answered = await post(target, { decision: "approve" }, { csrf });
        expect(answered.status, `POST ${target}`).toBe(303);
        expect(times(invocations, op), `POST ${target} reached ${op}`).toBe(1);
      }
      // Substituted handlers changed nothing, so if the page layer had written to D1 on
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
    `§13 · one renderer emits every HTML page, so every one carries Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" and Cache-Control: no-store — checked on the three shapes: /login anonymous, /apps shelled under the owner's cookie, /apps/new chromeless — while the hub's non-HTML answers, /styles.css and the surface's 404, carry neither (the twin; no-store added 2026-09-03)`,
    async () => {
      const CSP = "frame-ancestors 'self'; base-uri 'self'; object-src 'none'";
      const carriers = [
        await call(new Request(`${ORIGIN}${paths.login}`)),
        await get(paths.apps),
        await get(paths.appNew),
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

describe(`§13 · /agents and /agents/<slug> — the list, the five panes, and what points at them`, () => {
  // Rows first (§9 rule 1), from §13's sections as the 2026-09-16 three-pane brief redraws
  // them; the app pane — the grant set itself — is its own describe below.

  it(`§13 · /agents lists one row per agent whose slug is an anchor stretched over the whole row (a class="row-link" inside the class="agent-row", with the trailing chevron), the description beneath, Access in one line as "N apps · A allowed · K ask first · D dormant" counted over the grant sets with no catalog read, Tokens and Created as today, and Delete as the row's only control · an agent holding nothing reads "no grants", and the empty namespace still reads "No agents yet. Create one to give an AI agent its own grants and keys." beside New agent (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [
        { slug: "linear", kind: "tunnel", name: "Linear" },
        { slug: "news", kind: "tunnel" },
        { slug: "parked", kind: "tunnel", archived: true },
      ],
      agents: [
        {
          slug: "claude",
          description: "Claude sessions",
          grants: {
            // One of each bucket the Access line counts: an allow, an ask, a role the app
            // has never declared, and a grant on an app that is archived.
            linear: [{ role: "reader", mode: "allow" }, { role: "admin", mode: "approval" }],
            news: [{ role: "ghost", mode: "allow" }],
            parked: [{ role: "all", mode: "allow" }],
          },
          tokens: [{ as: "claude" }],
        },
        { slug: "cron", grants: {} },
      ],
    });
    // `reader` and `admin` are declared, so only `ghost` is dormant for want of a
    // declaration (a tunneled app's roles arrive at registration — seed FINDINGS 1).
    await new Registry(env.DB).upsertDeclaredRoles(ns.apps.linear.id, { reader: ["get_.*"], admin: ["admin_.*"] });
    const session = await seedOwnerSession(ns.owner);
    const html = await page(paths.agents, session.cookie);
    const text = textOf(html);

    // The row's link is the slug, stretched: the classes are the contract here, because
    // "the whole row is the link" exists nowhere else in the markup.
    const rowLink = [...html.matchAll(/<a\b([^>]*)>/g)].find(
      (anchor) => decodeEntities(attributeOf(anchor[1], "href") ?? "") === paths.agentDetail("claude"),
    );
    expect(rowLink, "no anchor to the agent page").toBeDefined();
    expect(attributeOf(rowLink?.[1] ?? "", "class") ?? "").toContain("row-link");
    expect(html).toContain("agent-row");
    expect(text).toContain("Claude sessions");

    // Access, in one line, over the grant sets: three apps, one allow, one ask, and two
    // dormant — the archived app's grant and the undeclared role.
    expect(text).toContain("3 apps · 1 allowed · 1 ask first · 2 dormant");
    expect(text).toContain("no grants");
    expect(text).toContain("1 active · never used");
    expect(html).toContain(`href="${paths.agentNew}"`);

    // Delete is the row's ONLY control: the list points at the agent page and at the
    // delete dialog, and never into a pane.
    expect(linkTexts(html, paths.agentsConfirmDelete("claude"))).toContain("Delete");
    for (const href of html.matchAll(/href="([^"]*)"/g)) {
      expect(decodeEntities(href[1]).startsWith(`${paths.agentDetail("claude")}/`), href[1]).toBe(false);
    }

    // The twin: the empty namespace.
    const fresh = await seedNamespace(env.DB, {});
    const empty = await page(paths.agents, (await seedOwnerSession(fresh.owner)).cookie);
    expect(textOf(empty)).toContain("No agents yet.");
    expect(textOf(empty)).toContain("Create one to give an AI agent its own grants and keys.");
    expect(empty).toContain(`href="${paths.agentNew}"`);
  });

  it(`§13 · the wide top nav holds five entries in §13's order — Apps · Agents · Audit · Approvals · Settings — on every shell page, Agents marked aria-current="page" on /agents and on /agents/<slug> and nowhere else · /apps marks Apps alone (the twin)`, async () => {
    const ORDER = [paths.apps, paths.agents, paths.audit, paths.approvals, paths.settings];
    const navOf = (html: string): { href: string; current: boolean }[] => {
      const nav = /<nav class="nav">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
      return [...nav.matchAll(/<a class="nav-link" href="([^"]*)"( aria-current="page")?>/g)].map((m) => ({
        href: m[1],
        current: m[2] !== undefined,
      }));
    };
    const pages: [string, string][] = [
      [paths.agents, paths.agents],
      [paths.agentDetail("agent"), paths.agents],
      [paths.apps, paths.apps],
      [paths.audit, paths.audit],
      [paths.approvals, paths.approvals],
      [paths.settings, paths.settings],
    ];
    for (const [path, current] of pages) {
      const nav = navOf(await page(path));
      expect(nav.map((entry) => entry.href), path).toEqual(ORDER);
      expect(nav.filter((entry) => entry.current).map((entry) => entry.href), path).toEqual([current]);
    }
  });

  it(`§13 · every shell page carries the narrow shell's sidebar beside that wide nav, in the same document and with no script — the hamburger <a href="#menu" class="menu-open" aria-label="Menu">, the <nav id="menu" class="menu"> holding the same five entries in §13's order with aria-current="page" on the page's own and the Approvals pending count as its pill, the <a href="#" aria-label="Close menu"> and the <a href="#" class="scrim" aria-hidden="true"> that close it, and the username over the Sign out form at its foot — on /apps, /agents, /audit, /approvals, /settings and /agents/<slug> alike · the sign-in pages, which have no shell, render neither nav, no hamburger and no scrim (the twin)`, async () => {
    const ORDER: readonly string[] = [paths.apps, paths.agents, paths.audit, paths.approvals, paths.settings];
    // Its own namespace, with its own pending request: the count in the Approvals pill is
    // an assertion, and the fixture world's one approval is a row other cases decide.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel" }],
      // `agent` by name: `openApproval` opens its request as the namespace's own agent.
      agents: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] } }],
    });
    const session = await seedOwnerSession(ns.owner);
    await openApproval(ns, "news");

    /** An anchor that is a CONTROL rather than a destination, found by the class the
     *  stylesheet shows and hides it by — the two halves of the `:target` mechanism. */
    const anchorNamed = (html: string, className: string): string => {
      const found = [...html.matchAll(/<a\b([^>]*)>/g)].find(
        (anchor) => (attributeOf(anchor[1], "class") ?? "") === className,
      );
      return found?.[1] ?? "";
    };
    /** The sidebar's own markup: `#menu` is what the hamburger targets, so the id — not a
     *  class and not an order — is what identifies it. */
    const menuOf = (html: string): { attributes: string; body: string } | null => {
      const nav = [...html.matchAll(/<nav\b([^>]*)>([\s\S]*?)<\/nav>/g)].find(
        (candidate) => attributeOf(candidate[1], "id") === "menu",
      );
      return nav === undefined ? null : { attributes: nav[1], body: nav[2] };
    };

    const pages: [string, string][] = [
      [paths.apps, paths.apps],
      [paths.agents, paths.agents],
      [paths.audit, paths.audit],
      [paths.approvals, paths.approvals],
      [paths.settings, paths.settings],
      [paths.agentDetail("agent"), paths.agents],
    ];
    for (const [path, current] of pages) {
      const html = await page(path, session.cookie);

      // Both navigations, in ONE document: the wide nav stays where it was and the
      // sidebar is drawn beside it, which is what lets CSS alone choose between them.
      expect(html, path).toContain(`<nav class="nav">`);
      const menu = menuOf(html);
      expect(menu, `${path}: no #menu sidebar`).not.toBeNull();
      expect(attributeOf(menu?.attributes ?? "", "class"), path).toBe("menu");

      // The three controls, each an ANCHOR carrying a URL — a page whose menu opened by
      // script would carry buttons here, and would not open with scripting off.
      const hamburger = anchorNamed(html, "menu-open");
      expect(attributeOf(hamburger, "href"), `${path}: the hamburger`).toBe("#menu");
      expect(attributeOf(hamburger, "aria-label"), `${path}: the hamburger`).toBe("Menu");
      const scrim = anchorNamed(html, "scrim");
      expect(attributeOf(scrim, "href"), `${path}: the scrim`).toBe("#");
      expect(attributeOf(scrim, "aria-hidden"), `${path}: the scrim`).toBe("true");
      const close = [...(menu?.body ?? "").matchAll(/<a\b([^>]*)>/g)].find(
        (anchor) => attributeOf(anchor[1], "aria-label") === "Close menu",
      );
      expect(close, `${path}: no close control`).toBeDefined();
      expect(attributeOf(close?.[1] ?? "", "href"), `${path}: the close control`).toBe("#");

      // The five entries the wide nav holds, in the same order, with this page's own
      // marked — read off the sidebar, so `aria-current` is tested on one nav per page.
      const entries = [...(menu?.body ?? "").matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((anchor) => ({
        href: decodeEntities(attributeOf(anchor[1], "href") ?? ""),
        current: attributeOf(anchor[1], "aria-current") === "page",
        parts: topLevelElements(anchor[2]),
      }));
      const nav = entries.filter((entry) => ORDER.includes(entry.href));
      expect(nav.map((entry) => entry.href), path).toEqual(ORDER);
      expect(nav.filter((entry) => entry.current).map((entry) => entry.href), path).toEqual([current]);

      // The pending count is an element of the Approvals entry rather than words in its
      // label — the pill the wide nav draws as its badge.
      const approvals = nav.find((entry) => entry.href === paths.approvals);
      expect(approvals?.parts.map((part) => textOf(part)), `${path}: the Approvals pill`).toContain("1");

      // The foot: who is signed in, and the one form that signs them out.
      expect(textOf(menu?.body ?? ""), path).toContain(ns.owner.username);
      expect(formsPostingTo(menu?.body ?? "", paths.auth.signOut).length, `${path}: Sign out`).toBeGreaterThan(0);
    }

    // The twin: /login has no shell, so it has neither navigation and none of the three
    // controls — a sidebar over a page nobody is signed in to is nothing to open.
    const login = await anonymousPage(paths.login);
    expect(menuOf(login)).toBeNull();
    expect(login).not.toContain(`<nav class="nav">`);
    expect(login).not.toContain("menu-open");
    expect(login).not.toContain("scrim");
  });

  it(`§13 · every shell page's <main> carries exactly ONE of the three shape classes §2 of design/layout-and-density.md pins — page--document on /approvals, page--table on /apps, /agents and /audit, page--workspace on /settings, /agents/<slug> and /apps/<slug> — and none of the four the rename retires (page, page--narrow, page--paned, page--fluid), with one <main> per page where /apps and /approvals drew a <div class="page"> · /login, which has no shell, carries no <main class="page…"> at all (the twin)`, async () => {
    // Markup on purpose, and the second exception to this file's header rule: the shape
    // class is the CONTRACT between the page and the stylesheet — width cap, gutters and
    // the pane rules all key off which of the three a page writes — so it is not
    // incidental HTML. The CSS behind it is the stylesheet's business and is not pinned.
    const SHAPES: readonly string[] = ["page--document", "page--table", "page--workspace"];
    const RETIRED: readonly string[] = ["page", "page--narrow", "page--paned", "page--fluid"];
    /** Every <main> in the document as its class TOKENS — split rather than matched as a
     *  substring, so `page--document` is never read as the retired bare `page`. */
    const mainsOf = (html: string): string[][] =>
      [...html.matchAll(/<main\b([^>]*)>/g)].map((main) =>
        (attributeOf(main[1], "class") ?? "").split(/\s+/).filter(Boolean),
      );

    const shells: [string, string][] = [
      [paths.approvals, "page--document"],
      [paths.apps, "page--table"],
      [paths.agents, "page--table"],
      [paths.audit, "page--table"],
      [paths.settings, "page--workspace"],
      [paths.agentDetail("agent"), "page--workspace"],
      [paths.appDetail("news"), "page--workspace"],
    ];
    for (const [path, shape] of shells) {
      const mains = mainsOf(await page(path));
      expect(mains.length, `${path}: <main> count`).toBe(1);
      expect(mains[0].filter((token) => SHAPES.includes(token)), path).toEqual([shape]);
      expect(mains[0].filter((token) => RETIRED.includes(token)), `${path}: retired classes`).toEqual([]);
    }

    // The twin: the sign-in family has no shell, so it has no shaped <main> either — the
    // auth card is its own 400 px rule, not one of the three page shapes.
    for (const tokens of mainsOf(await anonymousPage(paths.login))) {
      expect(tokens.filter((token) => [...SHAPES, ...RETIRED].includes(token)), paths.login).toEqual([]);
    }
  });

  it(`§13/§8 · /agents/new renders agent_create's three fields — slug, name, description — and nothing else, and a posted create lands on the new agent's page · a slug the op refuses (reserved, taken, illegal) re-renders the form at 400 with the refusal under the field and creates nothing (the twin)`, async () => {
    const html = await page(paths.agentNew);
    // The create form by its action — the shell's Sign out form comes first in the document.
    const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find(
      (match) => decodeEntities(attributeOf(match[1], "action") ?? "") === paths.agentCreate,
    );
    expect(form, "no form posts to agent_create").toBeDefined();
    expect(namedControls(form?.[2] ?? "").sort()).toEqual(["description", "name", "slug"]);
    const csrf = csrfOf(html);

    const slug = uniqueSlug("bot");
    const created = await formPost(paths.agentCreate, { csrf, slug, name: "Bot", description: "Runs things" }, world.session.cookie);
    expect(created.status).toBe(303);
    expect(new URL(created.headers.get("Location") ?? "", ORIGIN).pathname).toBe(paths.agentDetail(slug));
    const landed = await page(paths.agentDetail(slug));
    expect(textOf(landed)).toContain("Bot");
    expect(textOf(landed)).toContain("Runs things");

    // The twin: a taken slug — the world's own agent — is refused by the op, and the form
    // comes back at 400 with the reason where the field is, having created nothing.
    const before = ((await ops.agent_list.handler(world.ns.owner.userId, {})) as { agents: { slug: string }[] }).agents.length;
    const refused = await formPost(paths.agentCreate, { csrf, slug: "agent", name: "", description: "" }, world.session.cookie);
    expect(refused.status).toBe(400);
    const again = await refused.text();
    expect(again).toContain('class="field-error"');
    expect(again).toContain(`action="${paths.agentCreate}"`);
    const after = ((await ops.agent_list.handler(world.ns.owner.userId, {})) as { agents: { slug: string }[] }).agents.length;
    expect(after).toBe(before);
  });

  it(`§13 · Delete opens the same list with the confirm dialog at ?confirm=delete-agent&slug=, titled "Delete agent “<slug>”?" over "Deleting an agent deletes its tokens and removes its grants everywhere.", whose form fronts agent_delete — afterwards the agent, its keys and its grants are gone and /agents lands with the notice · a slug naming no agent draws no dialog (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel" }],
      agents: [{ slug: "doomed", grants: { news: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "key" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const html = await page(paths.agentsConfirmDelete("doomed"), session.cookie);
    expect(html).toContain("<dialog");
    expect(textOf(html)).toContain("Delete agent “doomed”?");
    expect(textOf(html)).toContain("Deleting an agent deletes its tokens and removes its grants everywhere.");
    expect(formsPostingTo(html, paths.agentDelete("doomed")).length).toBeGreaterThan(0);

    const deleted = await formPost(paths.agentDelete("doomed"), { csrf: csrfOf(html) }, session.cookie);
    expect(deleted.status).toBe(303);
    const landing = new URL(deleted.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(paths.agents);
    expect(landing.searchParams.get("done")).toBe("agent_delete");
    const agents = (await ops.agent_list.handler(ns.owner.userId, {})) as { agents: { slug: string }[] };
    expect(agents.agents.map((row) => row.slug)).not.toContain("doomed");
    const tokens = (await ops.token_list.handler(ns.owner.userId, {})) as { tokens: { kind: string; refSlug: string }[] };
    expect(tokens.tokens.filter((row) => row.kind === "agent" && row.refSlug === "doomed")).toEqual([]);

    // The twin: a slug naming no agent draws no dialog at all.
    expect(await page(paths.agentsConfirmDelete("nobody"), session.cookie)).not.toContain("<dialog");
  });

  it(`§2 · new is reserved from agent slugs: agent_create refuses "new" and GET /agents/new is the form, never a page for an agent called new · any other charset-legal slug creates and answers at /agents/<slug> (the twin)`, async () => {
    const csrf = csrfOf(await page(paths.agentNew));
    const refused = await formPost(paths.agentCreate, { csrf, slug: "new", name: "", description: "" }, world.session.cookie);
    expect(refused.status).toBe(400);
    expect(textOf(await refused.text())).toContain("reserved");
    const form = await page(paths.agentNew);
    expect(textOf(form)).toContain("New agent");
    expect(form).not.toContain("Danger zone");

    // The twin: any other charset-legal slug creates and answers at its own page.
    const slug = uniqueSlug("legal");
    const created = await formPost(paths.agentCreate, { csrf, slug, name: "", description: "" }, world.session.cookie);
    expect(created.status).toBe(303);
    expect(textOf(await page(paths.agentDetail(slug)))).toContain(slug);
  });

  it(`§13 · /agents/<slug> renders the FIRST app in slug order the agent holds a grant on, in place and under its own URL — the title row reading "Agents › <slug>", Agents a link to /agents in that same row and no agent badge anywhere in the header, then the name when it differs, the description, Created and the tiles "N apps · A allow · K ask first · D dormant" — with no alias URL for that pane · an agent holding no grant lands on the grant step, in place (the twin)`, async () => {
    const { cookie } = await withAgentPanes();
    const html = await page(paths.agentDetail("claude"), cookie);
    const text = textOf(html);

    // The crumb IS the title row: the link, the ›, and the slug in one row — never a line
    // of its own above it, and never carrying the app or pane the page happens to render.
    const header = html.slice(html.indexOf("<main"), html.indexOf("<nav", html.indexOf("<main")));
    expect(textOf(header)).toContain("Agents › claude");
    expect(header).toMatch(/<a[^>]*href="\/agents"[^>]*>Agents<\/a>[\s\S]{0,60}›[\s\S]{0,60}<h1[^>]*>claude<\/h1>/);
    // The badge is gone: `agent` as a word of its own appears nowhere in the header
    // (`Agents` is the crumb, and the lookahead is what keeps the two apart).
    expect(textOf(header)).not.toMatch(/(?<!\w)agent(?!\w)/);
    expect(text).toContain("Claude");
    expect(text).toContain("Claude sessions");
    expect(text).toContain("Created");
    // Tiles, one per count — the header's own row, not one sentence.
    for (const tile of ["3 apps", "1 allow", "1 ask first", "1 dormant"]) expect(text, tile).toContain(tile);

    // The landing IS an app pane, and the app it renders is the first granted slug —
    // `linear`, not `news`, and not `brand`, which this agent holds nothing on. What
    // proves WHICH pane was rendered is the form only that pair's pane carries.
    expect(html).toContain(`action="${paths.agentGrantSet("claude", "linear")}"`);
    expect(html).not.toContain(`action="${paths.agentGrantSet("claude", "news")}"`);

    // The twin: an agent holding no grant lands on the grant step, in place.
    const bare = await page(paths.agentDetail("cron"), cookie);
    expect(textOf(bare)).toContain(
      "What each app does; open it to see every endpoint and which roles grant it. Grant opens the app with nothing granted yet.",
    );
    expect(bare).toContain(`href="${paths.agentApp("cron", "brand")}"`);
  });

  it(`§13 · the agent page's root carries data-level chosen from the URL alone — 1 on /agents/<slug>, 2 on /agents/<slug>/apps/<app> and on /grant, /credentials, /activity and /danger, 3 on a pane URL carrying sel= — and the level header above the content names the level above and the current thing: at 1 the back link "‹ Agents" → /agents titled with the slug, at 2 "‹ <slug>" → /agents/<slug> titled with the app's name or "Grant another app" / "Credentials" / "Activity" / "Danger zone", at 3 "‹ <the app or pane name>" → that pane's own URL with sel dropped and q, show and calls kept, titled with the selected row's name · the wide title row "Agents › <slug>" is still in the document at every one of the three levels (the twin)`, async () => {
    // Its own world: the three levels need a granted app to open, a key to list and one
    // call in the trail to select, and every row here READS — nothing the shared agent
    // world would answer for.
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel", name: "News MCP" }],
      agents: [{ slug: "claude", grants: { news: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "key" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    await record(env.DB, {
      ownerId: ns.owner.userId,
      principal: "agent:claude",
      event: "tools/call",
      app: "news",
      tool: "get_news",
      outcome: "ok",
      durationMs: 7,
    });
    const call = (await query(env.DB, ns.owner.userId, { tool: "get_news" })).rows[0];
    expect(call, "no ledger row for the seeded call").toBeDefined();

    const detail = paths.agentDetail("claude");
    const app = paths.agentApp("claude", "news");
    const activity = paths.agentPane("claude", "activity");
    const levels: { url: string; level: string; back: string; to: string; title: string }[] = [
      { url: detail, level: "1", back: "‹ Agents", to: paths.agents, title: "claude" },
      { url: app, level: "2", back: "‹ claude", to: detail, title: "News MCP" },
      { url: paths.agentPane("claude", "grant"), level: "2", back: "‹ claude", to: detail, title: "Grant another app" },
      { url: paths.agentPane("claude", "credentials"), level: "2", back: "‹ claude", to: detail, title: "Credentials" },
      { url: activity, level: "2", back: "‹ claude", to: detail, title: "Activity" },
      { url: paths.agentPane("claude", "danger"), level: "2", back: "‹ claude", to: detail, title: "Danger zone" },
      // Level 3 twice, so "the pane URL without sel" is read on a pane whose other query
      // field is `q` and on one whose other field is `calls` — both kept, sel alone gone.
      { url: `${app}?q=all&sel=role:all`, level: "3", back: "‹ News MCP", to: `${app}?q=all`, title: "all" },
      {
        url: `${activity}?calls=40&sel=call:${call.id}`,
        level: "3",
        back: "‹ Activity",
        to: `${activity}?calls=40`,
        title: "get_news",
      },
    ];

    for (const row of levels) {
      const html = await page(row.url, session.cookie);
      // The level is the page root's, so it is one attribute on one element — a second
      // `data-level` anywhere would mean the level was decided twice.
      expect([...html.matchAll(/\sdata-level="([^"]*)"/g)].map((match) => match[1]), row.url).toEqual([row.level]);

      const header = levelHeader(html);
      expect(header.back, `${row.url}: the back link`).toBe(row.back);
      expect(header.href, `${row.url}: the back link`).toBe(row.to);
      expect(header.title, `${row.url}: the level header's title`).toContain(row.title);

      // The twin: the level header ADDS a navigation below the breakpoint — it does not
      // replace the wide title row, which is still in the document at every level.
      expect(textOf(html), row.url).toContain("Agents › claude");
    }
  });

  it(`§13 · the agent page renders no pill row — no nav.pill-row on the landing or on any of the five panes, the rail-as-list being its replacement there · /settings still renders its (the twin; 2026-09-16: /apps/<slug> left the twin when it took the levels too)`, async () => {
    const { cookie } = await withAgentPanes();
    for (const url of [
      paths.agentDetail("claude"),
      paths.agentApp("claude", "news"),
      ...AGENT_PANES.map((pane) => paths.agentPane("claude", pane)),
    ]) {
      const html = await page(url, cookie);
      expect(html, url).not.toContain("pill-row");
      const compact = [...html.matchAll(/<nav\b[^>]*aria-label="([^"]*)"[^>]*>/g)]
        .map((nav) => nav[1])
        .filter((label) => label.endsWith("compact"));
      expect(compact, url).toEqual([]);
      // Non-vacuous on this same render: what the page draws instead is right there.
      expect(agentRail(html, "claude").length, url).toBeGreaterThan(0);
    }

    // The twin: the rule is the two level pages' — /settings keeps the pill row §13 gave
    // it (the app page's own absence is the app page's row).
    expect(navBlock(await page(paths.settings), PILL_NAV_LABEL), paths.settings).not.toBeNull();
  });

  it(`§13 · each pane answers on its own URL — /agents/<slug>/apps/<app>, /grant, /credentials, /activity, /danger — and /apps/<app> for an ACTIVE app the agent holds nothing on renders the new-grant state: an empty set, the header's dashed "new grant · nothing saved yet" badge and the app in the rail · an unknown pane segment, and an unknown, builtin, foreign or ungranted archived app, are noSuchPage (the twin)`, async () => {
    const { cookie } = await withAgentPanes();
    for (const pane of AGENT_PANES) {
      expect((await get(paths.agentPane("claude", pane), cookie)).status, pane).toBe(200);
    }
    expect((await get(paths.agentApp("claude", "news"), cookie)).status).toBe(200);

    // An ACTIVE app this agent holds nothing on: the pane renders, the set is empty, the
    // badge says so, and the rail carries the app it is about.
    const fresh = await page(paths.agentApp("claude", "brand"), cookie);
    expect(textOf(fresh)).toContain("new grant · nothing saved yet");
    const chosen = paneSubmission(fresh, paths.agentGrantSet("claude", "brand"));
    expect(Object.keys(chosen).filter((name) => name.startsWith("e.")).length).toBeGreaterThan(0);
    for (const [name, value] of Object.entries(chosen)) {
      if (name.startsWith("e.")) expect(value, name).toBe("none");
    }
    expect(agentRail(fresh, "claude").map((entry) => entry.href)).toContain(paths.agentApp("claude", "brand"));

    // The twin: everything that is not a pane of this agent is the hub's 404 — an unknown
    // segment, the bare `apps` with no app, an unknown app, the builtin, an app of another
    // namespace, and an archived app this agent holds nothing on.
    for (const url of [
      `${paths.agentDetail("claude")}/nowhere`,
      `${paths.agentDetail("claude")}/apps`,
      paths.agentApp("claude", uniqueSlug("nosuch")),
      paths.agentApp("claude", PMCP_SLUG),
      paths.agentApp("claude", "notion"),
      paths.agentApp("cron", "parked"),
    ]) {
      const missing = await get(url, cookie);
      expect(missing.status, url).toBe(404);
      expect(await missing.text(), url).toContain("No such page");
    }
  });

  it(`§13 · the moved editor keeps its old URLs as permanent moves: GET /agents/<slug>/grants/<app> answers 301 to /agents/<slug>/apps/<app> · GET /agents/<slug>/grants answers 301 to /agents/<slug>/grant (the twin)`, async () => {
    const { cookie } = await withAgentPanes();
    // Spelled, not built: the whole point of these two rows is that the OLD spelling still
    // answers, and `paths` no longer carries it.
    const moved = await get("/agents/claude/grants/news", cookie);
    expect(moved.status).toBe(301);
    expect(new URL(moved.headers.get("Location") ?? "", ORIGIN).pathname).toBe(paths.agentApp("claude", "news"));

    // The twin: the chooser's old URL moves to the grant step.
    const chooser = await get("/agents/claude/grants", cookie);
    expect(chooser.status).toBe(301);
    expect(new URL(chooser.headers.get("Location") ?? "", ORIGIN).pathname).toBe(paths.agentPane("claude", "grant"));
  });

  it(`§13 · the rail carries "Apps · N" — one entry per granted app in slug order, then "+ Grant another app…" with the count of grantable apps — then the "Agent" group (Credentials with its live · clients counts, Activity with its pending-approval count) and the tail group Danger zone, the open pane's entry marked aria-current="page" · a set holding an approval entry marks its entry rail-dot--warn, and an archived app draws the dash and rail-link--dim — and nothing else, the rail never reads a catalog — (the twin)`, async () => {
    const { cookie } = await withAgentPanes();
    const html = await page(paths.agentApp("claude", "news"), cookie);
    const rail = agentRail(html, "claude");
    expect(rail.map((entry) => entry.href)).toEqual([
      paths.agentApp("claude", "linear"),
      paths.agentApp("claude", "news"),
      paths.agentApp("claude", "parked"),
      paths.agentPane("claude", "grant"),
      paths.agentPane("claude", "credentials"),
      paths.agentPane("claude", "activity"),
      paths.agentPane("claude", "danger"),
    ]);
    expect(rail.filter((entry) => entry.current).map((entry) => entry.href)).toEqual([
      paths.agentApp("claude", "news"),
    ]);
    // The groups, and the one count the rail computes from the namespace rather than from
    // this agent's own set: `brand` is the only active app it holds nothing on.
    const block = agentRailBlock(html, "claude");
    expect(textOf(block)).toContain("Apps · 3");
    expect(textOf(block)).toContain("Agent");
    expect(rail.find((entry) => entry.href === paths.agentPane("claude", "grant"))?.marker).toContain("1");

    // The markers, which are the rail's whole vocabulary: amber where an entry asks first,
    // the dash and the dimmed link where the app is archived, and neither anywhere else.
    expect(railAnchor(html, "claude", paths.agentApp("claude", "news"))).toContain("rail-dot--warn");
    expect(railAnchor(html, "claude", paths.agentApp("claude", "linear"))).not.toContain("rail-dot--warn");
    const parked = railAnchor(html, "claude", paths.agentApp("claude", "parked"));
    expect(parked).toContain("rail-link--dim");
    expect(rail.find((entry) => entry.href === paths.agentApp("claude", "parked"))?.marker).toBe(DIMMED_MARKER);
  });

  it(`§13 · /agents/<slug>/grant lists one card per active non-builtin app the agent holds nothing on — name, slug, kind and status badges, description, and, while the card is CLOSED, "roles <names> · show endpoints" alone (the link, ?show=<app>), no count and no catalog read — under "What each app does; open it to see every endpoint and which roles grant it. Grant opens the app with nothing granted yet." and beside a Grant link to /agents/<slug>/apps/<app> · the OPEN card is the read: "T tools · P prompts · R resources · roles <names> · hide" above the endpoint list, whose rows carry the role badges that grant each entry or "only via all or by name", while q filters the cards by app name, slug, description or endpoint name and opens the ones it matched, and an agent holding every active app reads "<agent> already holds a grant on every active app. Archived apps are not listed; unarchive one to grant it." (the twin)`, async () => {
    const { cookie } = await withAgentPanes();
    const grant = paths.agentPane("claude", "grant");
    const html = await page(grant, cookie);
    const text = textOf(html);
    expect(text).toContain("Grant another app");
    expect(text).toContain(
      "What each app does; open it to see every endpoint and which roles grant it. Grant opens the app with nothing granted yet.",
    );
    // Exactly the active apps held nothing on: `brand` — never `parked` (archived), never
    // an app already granted, and never the builtin.
    expect(text).toContain("Apps · 1");
    expect(text).toContain("Brand");
    expect(html).toContain(`href="${paths.agentApp("claude", "brand")}"`);
    expect(linkTexts(html, paths.agentApp("claude", "brand"))).toContain("Grant");

    // CLOSED: the roles it declares and the link that would open it — and nothing that
    // could only come from a catalog, because a closed card has not read one.
    expect(text).toContain("roles reader · show endpoints");
    expect(text).not.toMatch(/\d+ tools/);
    expect(linkTexts(html, `${grant}?show=brand`)).toContain("show endpoints");
    expect(text).not.toContain("purge_cache");

    // OPEN: the counts ARE the read, and the list names what grants each entry.
    const opened = await page(`${grant}?show=brand`, cookie);
    const shown = textOf(opened);
    expect(shown).toMatch(/3 tools · \d+ prompts · \d+ resources · roles reader · hide/);
    expect(linkTexts(opened, grant)).toContain("hide");
    expect(shown).toContain("purge_cache");
    expect(shown).toContain("reader");
    expect(shown).toContain("only via all or by name");

    // `q` filters by endpoint name too, and opens the cards it matched.
    const searched = textOf(await page(`${paths.agentPane("claude", "grant")}?q=purge_cache`, cookie));
    expect(searched).toContain("Brand");
    expect(searched).toContain("purge_cache");

    // The twin: an agent already granted on every active app is offered none.
    const full = textOf(await page(paths.agentPane("everywhere", "grant"), cookie));
    expect(full).toContain(
      "everywhere already holds a grant on every active app. Archived apps are not listed; unarchive one to grant it.",
    );
  });

  it(`§13/§4 · /agents/<slug>/credentials lists the agent's unrevoked keys under "Tokens · N" beside one form whose expires_in select offers 2592000 / 7776000 / 31536000 / never and whose Issue token answers 200 in place — the reveal above the list, the plaintext on no URL of the response · a live row offers Revoke at ?confirm=revoke-token&id= where an expired one offers Remove at ?confirm=remove-token&id= ("Remove expired token <prefix>?" over "It expired <date>; removing it keeps its history."), both dialogs posting token_revoke and landing back on this pane, while "Connected clients · N" is read-only, each row linking to /settings/clients (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel" }],
      agents: [
        {
          slug: "keyed",
          grants: { news: [{ role: "all", mode: "allow" }] },
          tokens: [{ as: "live" }, { as: "dead", expired: true }],
        },
      ],
    });
    const session = await seedOwnerSession(ns.owner);
    await consentOnce(ns, session.cookie, "keyed", { client_name: "Claude Desktop" });
    const pane = paths.agentPane("keyed", "credentials");
    const html = await page(pane, session.cookie);
    const text = textOf(html);
    const keyed = (await tokensOf(ns.owner.userId)).filter((token) => token.refSlug === "keyed");
    const dead = keyed.find((token) => token.id === ns.tokens.dead.id);
    const live = keyed.find((token) => token.id === ns.tokens.live.id);
    expect(dead, "the expired key vanished").toBeDefined();
    expect(live, "the live key vanished").toBeDefined();
    expect(text).toContain("Tokens · 2");

    // The select the Issue control carries, in §4's own seconds.
    const select = /<select\b[^>]*name="expires_in"[^>]*>([\s\S]*?)<\/select>/.exec(html);
    expect(select, "the pane rendered no expires_in select").not.toBeNull();
    expect(optionValues(select?.[1] ?? "")).toEqual(["2592000", "7776000", "31536000", "never"]);

    // Issue answers 200 IN PLACE, on this pane's own URL, with the plaintext in the reveal
    // and on no URL of the response.
    const issueTarget = actionFor(html, "token_issue");
    const issued = await formPost(issueTarget, { ...formsPostingTo(html, issueTarget)[0], csrf: csrfOf(html) }, session.cookie);
    expect(issued.status).toBe(200);
    const revealed = await issued.text();
    const plaintext = /pmcp_agt_[A-Za-z0-9]+/.exec(textOf(revealed))?.[0];
    expect(plaintext, "no plaintext key in the reveal").toBeDefined();
    for (const href of revealed.matchAll(/href="([^"]*)"/g)) expect(href[1]).not.toContain(plaintext ?? "!");
    expect(railAnchor(revealed, "keyed", pane), "the reveal is the pane, re-rendered").toBeTruthy();

    // Revoke on the live row, Remove on the expired one — two dialogs, one op, and both
    // land back here.
    expect(links(html, `${pane}?confirm=revoke-token&id=${live?.id}`)).toBe(true);
    expect(links(html, `${pane}?confirm=remove-token&id=${dead?.id}`)).toBe(true);
    const remove = await page(`${pane}?confirm=remove-token&id=${dead?.id}`, session.cookie);
    expect(remove).toContain("<dialog");
    expect(textOf(remove)).toContain(`Remove expired token ${dead?.prefix}?`);
    expect(textOf(remove)).toContain("removing it keeps its history.");
    const removeTarget = actionFor(remove, "token_revoke");
    const removed = await formPost(removeTarget, { csrf: csrfOf(remove) }, session.cookie);
    expect(removed.status).toBe(303);
    expect(new URL(removed.headers.get("Location") ?? "", ORIGIN).pathname).toBe(pane);
    const revoke = await page(`${pane}?confirm=revoke-token&id=${live?.id}`, session.cookie);
    const revoked = await formPost(actionFor(revoke, "token_revoke"), { csrf: csrfOf(revoke) }, session.cookie);
    expect(revoked.status).toBe(303);
    expect(new URL(revoked.headers.get("Location") ?? "", ORIGIN).pathname).toBe(pane);

    // The twin: the clients half is read-only — it links into Settings and fronts no
    // revocation of its own.
    expect(text).toContain("Claude Desktop");
    expect(html).toContain(`href="${paths.settingsClients}"`);
    expect(postTargets(html).some((target) => target.endsWith("connection_revoke"))).toBe(false);
  });

  it(`§13/§15 · /agents/<slug>/activity lists "Awaiting approval · N" rows whose Reject and Approve post approval_decide to /agents/<slug>/approval_decide and land back on this pane, leaving the decided row dimmed with its status badge, above "Recent calls · N" from audit_query with one outcome badge per row (ok / approval required / not permitted / the failure) · sel=call:<id> on a refused call carries "Refused before the call was made, so there are no bodies to show." and the link /audit?expand=<id>#event-<id> (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel" }],
      agents: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] } }],
    });
    const session = await seedOwnerSession(ns.owner);
    const approvalId = await openApproval(ns, "news");
    // Two calls, so the badge vocabulary has both a success and a refusal to spell — the
    // refused one deliberately recording no bodies, which is the sentence the twin reads.
    await record(env.DB, {
      ownerId: ns.owner.userId,
      principal: "agent:agent",
      event: "tools/call",
      app: "news",
      tool: "ok-tool",
      outcome: "ok",
      durationMs: 12,
      args: { q: "term" },
    });
    await record(env.DB, {
      ownerId: ns.owner.userId,
      principal: "agent:agent",
      event: "tools/call",
      app: "news",
      tool: "refused-tool",
      outcome: "-32001",
      durationMs: 1,
    });
    const pane = paths.agentPane("agent", "activity");
    const html = await page(pane, session.cookie);
    const text = textOf(html);
    expect(text).toContain("Awaiting approval · 1");
    expect(text).toContain("the last 7 days, the retention window");
    expect(html).toContain(`href="${paths.audit}?principal=agent:agent"`);

    // Recent calls, each with its outcome — the audit page's own vocabulary, which is
    // where this pane's rows come from.
    expect(text).toContain("ok-tool");
    expect(text).toContain("refused-tool");
    // A badge names the outcome; the raw JSON-RPC code the ledger stores is not a word a
    // reader is owed, which is what "outcome badge" means here.
    expect(text).not.toContain("-32001");

    // Both decisions are drawn, each a form of its own whose target names the op and
    // carries the op's own fields — and approving lands back on this pane.
    const decide = (decision: "approve" | "reject"): string =>
      paths.agentOp("agent", "approval_decide", { id: approvalId, decision });
    expect(formsPostingTo(html, decide("reject")).length, "no Reject form").toBeGreaterThan(0);
    expect(formsPostingTo(html, decide("approve")).length, "no Approve form").toBeGreaterThan(0);
    const decided = await formPost(decide("approve"), { csrf: csrfOf(html) }, session.cookie);
    expect(decided.status).toBe(303);
    expect(new URL(decided.headers.get("Location") ?? "", ORIGIN).pathname).toBe(pane);
    expect(textOf(await page(pane, session.cookie))).toContain("approved");

    // The twin: the details of a refused call say why there are no bodies, and point at
    // the same row in the trail.
    const refused = (await query(env.DB, ns.owner.userId, { tool: "refused-tool" })).rows[0];
    expect(refused, "no ledger row for the refused call").toBeDefined();
    const details = await page(`${pane}?sel=call:${refused.id}`, session.cookie);
    expect(textOf(details)).toContain("Refused before the call was made, so there are no bodies to show.");
    expect(details).toContain(`href="${paths.audit}?expand=${refused.id}#event-${refused.id}"`);
  });

  it(`§13/§15 · /agents/<slug>/activity pages the trail — Recent calls draws the newest twenty over a "Load 20 more" row that is a plain link carrying ?calls=<n+20> and reads "<remaining> older in the last 7 days · everything before that is in Audit" (Audit linking /audit?principal=agent:<slug>), and under ?calls=<n> the list draws n rows with the summary counting over the rows shown, "last N calls · ok · denied · K awaiting approval" · a week the list has exhausted reads "That is the whole week — older calls are in Audit." (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel" }],
      agents: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] } }],
    });
    const session = await seedOwnerSession(ns.owner);
    await openApproval(ns, "news");
    // Twenty-five calls, oldest first — the two refusals among the OLDEST, so a page that
    // shows twenty of them counts differently from one that shows all twenty-five, which
    // is what "counts what is shown" means and what a total over the week would not.
    for (let at = 0; at < 25; at++) {
      await record(env.DB, {
        ownerId: ns.owner.userId,
        principal: "agent:agent",
        event: "tools/call",
        app: "news",
        tool: `paged-${at}`,
        outcome: at < 2 ? "-32001" : "ok",
        durationMs: 5,
      });
    }
    const pane = paths.agentPane("agent", "activity");
    const html = await page(pane, session.cookie);
    const text = textOf(html);

    // Twenty rows, newest first: the newest is there, the twentieth is there, the
    // twenty-first is not — and the summary counts those twenty.
    expect(text).toContain("paged-24");
    expect(text).toContain("paged-5");
    expect(text).not.toContain("paged-4");
    expect(text).toContain("last 20 calls · 20 ok · 0 denied · 1 awaiting approval");

    // The next page is a plain LINK, so scripting off pages one reload at a time.
    expect(linkTexts(html, `${pane}?calls=40`)).toContain("Load 20 more");
    expect(text).toContain("more older calls in the last 7 days · everything before that is in Audit");
    expect(html).toContain(`href="${paths.audit}?principal=agent:agent"`);

    // The twin: a week the list has exhausted offers no next page, and says so.
    const all = await page(`${pane}?calls=40`, session.cookie);
    const shown = textOf(all);
    expect(shown).toContain("paged-0");
    expect(shown).toContain("last 25 calls · 23 ok · 2 denied · 1 awaiting approval");
    expect(shown).toContain("That is the whole week — older calls are in Audit.");
    expect(links(all, `${pane}?calls=60`)).toBe(false);
  });

  it(`§13 · /agents/<slug>/danger draws the Delete agent card over "Deleting an agent deletes its tokens, revokes its clients and removes its grants everywhere. This cannot be undone.", whose Delete <agent> opens the same ?confirm=delete-agent dialog the list draws and lands on /agents with the notice · every other mutation an agent pane fronts lands back on its own pane (the twin)`, async () => {
    const ns = await seedNamespace(env.DB, {
      apps: [{ slug: "news", kind: "tunnel" }],
      agents: [{ slug: "gone", grants: { news: [{ role: "all", mode: "allow" }] }, tokens: [{ as: "key" }] }],
    });
    const session = await seedOwnerSession(ns.owner);
    const danger = paths.agentPane("gone", "danger");
    const html = await page(danger, session.cookie);
    expect(textOf(html)).toContain(
      "Deleting an agent deletes its tokens, revokes its clients and removes its grants everywhere. This cannot be undone.",
    );
    expect(links(html, `${danger}?confirm=delete-agent`)).toBe(true);

    // The twin first, so the agent still exists to land on: a refused revoke posted from
    // the credentials pane comes back to the credentials pane with its failure.
    const credentials = paths.agentPane("gone", "credentials");
    const failed = await formPost(
      paths.agentOp("gone", "token_revoke", { id: "tok_nope" }),
      { csrf: csrfOf(await page(credentials, session.cookie)) },
      session.cookie,
    );
    expect(failed.status).toBe(303);
    const back = new URL(failed.headers.get("Location") ?? "", ORIGIN);
    expect(back.pathname).toBe(credentials);
    expect(back.searchParams.get("failed")).toBe("token_revoke");

    const dialog = await page(`${danger}?confirm=delete-agent`, session.cookie);
    expect(dialog).toContain("<dialog");
    expect(textOf(dialog)).toContain("Delete agent “gone”?");
    const deleted = await formPost(actionFor(dialog, "agent_delete"), { csrf: csrfOf(dialog) }, session.cookie);
    expect(deleted.status).toBe(303);
    const landing = new URL(deleted.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(paths.agents);
    expect(landing.searchParams.get("done")).toBe("agent_delete");
    const agents = (await ops.agent_list.handler(ns.owner.userId, {})) as { agents: { slug: string }[] };
    expect(agents.agents.map((row) => row.slug)).not.toContain("gone");
  });

  it(`§13 · the app pane's form is the one form the agent pages render whose fields are not its op's keys verbatim — one e.<entry> radio group per row, plus add / mode / drop / clear, composed by the route — and it is the only one: every other form on the five panes names an op's own fields (the twin, the parity-B sweep extended to /agents)`, async () => {
    const { ns, cookie } = await withAgentPanes();
    const key = (await tokensOf(ns.owner.userId)).find((token) => token.refSlug === "claude");
    if (key === undefined) throw new Error("the seeded agent key vanished");

    const seen = new Set<string>();
    for (const url of [
      paths.agents,
      paths.agentsConfirmDelete("claude"),
      paths.agentNew,
      paths.agentDetail("claude"),
      ...AGENT_PANES.map((pane) => paths.agentPane("claude", pane)),
      `${paths.agentPane("claude", "credentials")}?confirm=revoke-token&id=${key.id}`,
      `${paths.agentPane("claude", "danger")}?confirm=delete-agent`,
    ]) {
      for (const form of formsRenderedOn(await page(url, cookie))) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) continue;
        expect(Object.prototype.hasOwnProperty.call(ops, form.op), `${url} → ${form.op}`).toBe(true);
        seen.add(form.op);
        // The one exception, checked below rather than here — and the landing renders it,
        // since the landing IS an app pane.
        if (form.op === "grant_set") continue;
        // Both sides derived off admin.ops: every required field, and nothing the schema
        // does not declare. Not equality — `token_issue`'s optional `expires_in` is a
        // control here, and nothing else's is.
        for (const required of requiredKeysOf(ops[form.op])) {
          expect(form.fields, `${url} → ${form.op} required`).toContain(required);
        }
        for (const submitted of form.fields) {
          expect(schemaKeysOf(ops[form.op]), `${url} → ${form.op} submitted`).toContain(submitted);
        }
      }
    }
    for (const op of ["agent_create", "agent_delete", "token_issue", "token_revoke"]) {
      expect([...seen], op).toContain(op);
    }

    // The one exception, and it is exactly one: the app pane's save fronts `grant_set` and
    // submits no field the op declares — one `e.<entry>` per row plus the four the route
    // composes, which it turns into the op's `roles` array (§13; D15 constraint 35).
    const pane = await page(paths.agentApp("claude", "news"), cookie);
    const forms = formsRenderedOn(pane).filter((form) => !BROWSER_ONLY_TARGETS.has(form.op));
    expect(forms.map((form) => form.op)).toEqual(["grant_set"]);
    expect(forms[0].fields).not.toEqual(schemaKeysOf(ops.grant_set));
    expect(forms[0].fields.some((field) => field.startsWith("e."))).toBe(true);
    for (const field of forms[0].fields) {
      expect(schemaKeysOf(ops.grant_set), field).not.toContain(field);
      expect(field.startsWith("e.") || COMPOSED_GRANT_FIELDS.has(field), field).toBe(true);
    }
  });

  it(`§13 · every agent slug the other pages print links to /agents/<slug> — the Tokens pane's Bound to, the Connected clients pane's Acts as, the app page's Agents pane (its details' open agent page link, re-pointed 2026-09-17), and the consent screen's empty state, which now reads "Create one under Agents before connecting a client." — and the Tokens intro reads "Issue new keys from an app or agent page." again · app slugs still link to /apps/<slug> (the twin)`, async () => {
    const agentLink = `href="${paths.agentDetail("agent")}"`;
    const tokens = await page(paths.settingsTokens);
    expect(tokens).toContain(agentLink);
    expect(textOf(tokens)).toContain("Issue new keys from an app or agent page.");

    await consentOnce(world.ns, world.session.cookie, "agent", { client_name: "Pointer Client" });
    expect(await page(paths.settingsClients)).toContain(agentLink);
    // The app page's Agents pane points at the PAIR's pane now that it carries the grant
    // editor in place (2026-09-17), which is still a link to that agent's own page.
    expect(await page(`${paths.appPane("news", "access")}?sel=agent:agent`)).toContain(
      `href="${paths.agentApp("agent", "news")}"`,
    );

    const empty = await seedNamespace(env.DB, {});
    const consent = (
      await reachConsent((await registerOAuthClient()).clientId, (await seedOwnerSession(empty.owner)).cookie, {
        resource: oauthResourceFor(empty.owner.username),
      })
    ).html;
    // The link splits the sentence in the text projection; the words are what is pinned.
    expect(textOf(consent)).toMatch(/Create one under\s+Agents\s+before connecting a client/);
    expect(consent).toContain(`href="${paths.agentNew}"`);

    // The twin: app slugs still link to the app page.
    expect(tokens).toContain(`href="${paths.appDetail("news")}"`);
  });

  it.todo(`§6 · every agent slug the app page's Agents pane prints links to its own /agents/<agent>/apps/<slug> pane through the details' open agent page link, now that the app page carries the grant editor in place — the pane fronting grant_set itself rather than pointing at a second editor (the twin, re-pointed 2026-09-17)`);
});

describe(`§13 · /agents/<slug>/apps/<app> — the (agent × app) grant pane`, () => {
  // The listing and its details pane: the one page that reads a catalog, and the one form
  // that writes a grant set.
  it(`§13 · the listing header carries the app's name, slug, kind badge and status badge, the reach line "<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources" computed over the SAVED set, then the filter row (a GET form q, placeholder "filter, or type a pattern…") and the groups Roles · N ("declared by the app at connect" / "defined in config"), Tools · N ("R reached · U not"), Prompts · N, Resources · N ("matched by URI") and Patterns · N ("entries that are not one item") in that order · a family the hub cannot list renders one note line in its group — "<app> has not connected yet — nothing to list until it does." / "is not advertised" / "could not be read just now" (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const html = await page(paths.agentApp("askrole", "feed"), cookie);
    const text = textOf(html);
    expect(text).toContain("News MCP");
    expect(text).toContain("feed");

    // The reach line, over the SAVED set: `reader` asks first, so every tool it reaches is
    // reachable and gated, and the third tool is neither.
    expect(text).toContain("askrole reaches 2 of 3 tools · 2 ask first · 1 of 1 prompts · 1 of 1 resources");
    expect(html).toContain('placeholder="filter, or type a pattern…"');

    // The groups, in §13's order, each with its count.
    let at = -1;
    for (const heading of ["Roles ·", "Tools · 3", "Prompts · 1", "Resources · 1"]) {
      const next = text.indexOf(heading);
      expect(next, heading).toBeGreaterThan(at);
      at = next;
    }
    expect(text).toContain("2 reached · 1 not");
    // The Patterns group is the set's own, so it is drawn where the set holds one.
    expect(textOf(await page(paths.agentApp("direct", "feed"), cookie))).toContain("Patterns ·");

    // The twin: a tunneled app that has never connected has nothing to list, and says so
    // in the group rather than leaving it blank.
    const quiet = textOf(await page(paths.agentApp("dormant", "silent"), cookie));
    expect(quiet).toContain("silent has not connected yet — nothing to list until it does.");
  });

  it(`§13 · one role row per declared role — the name, the patterns per family beneath it and "matches N" — carries one control: three radios in a .seg named e.<role>, in the order none · ask · allow with values none / approval / allow, checked at the mode the saved set holds for that role · the built-in all, badged built-in, is last whatever order the declaration arrived in (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const html = await page(paths.agentApp("askrole", "feed"), cookie);
    expect(segOf(html, "reader").map((button) => button.value)).toEqual(["none", "approval", "allow"]);
    expect(checkedIn(html, "reader")).toBe("approval");
    expect(checkedIn(html, "purger")).toBe("none");
    expect(checkedIn(html, "all")).toBe("none");

    // `all` LAST, whatever order the declaration arrived in, and marked as the built-in.
    expect(html.indexOf('name="e.all"')).toBeGreaterThan(html.indexOf('name="e.purger"'));
    expect(html.indexOf('name="e.all"')).toBeGreaterThan(html.indexOf('name="e.reader"'));
    const text = textOf(html);
    expect(text).toMatch(/all\s+built-in/);

    // The twin: a row says what its role matches — the patterns, per family, and a count.
    expect(text).toContain("get_.*");
    expect(text).toContain("purge_cache");
    expect(text).toMatch(/matches \d+/);
  });

  it(`§13 · an item row a granted role already reaches draws the implied mode hollow (.impl, and .warn when the role only asks) and marks every button BELOW it disabled with title "<roles> grants <ask|allow> — change the role to lower it", the row reading "via <roles>" · an item no role reaches draws the three buttons plain and enabled, with no via line (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const allowed = await page(paths.agentApp("viarole", "feed"), cookie);
    const implied = segOf(allowed, "tool/get_news");
    expect(implied.map((button) => button.value)).toEqual(["none", "approval", "allow"]);
    // Everything below the implied allow is unclickable, and says why.
    expect(implied.filter((button) => button.disabled).map((button) => button.value)).toEqual(["none", "approval"]);
    expect(allowed).toContain('title="reader grants allow — change the role to lower it"');
    expect(textOf(allowed)).toContain("via reader");

    // A role that only ASKS implies less, so only the button below ask is disabled.
    const asked = await page(paths.agentApp("askrole", "feed"), cookie);
    expect(segOf(asked, "tool/get_news").filter((button) => button.disabled).map((button) => button.value)).toEqual([
      "none",
    ]);
    expect(asked).toContain('title="reader grants ask — change the role to lower it"');

    // The twin: an item no granted role reaches is a free choice.
    expect(segOf(allowed, "tool/purge_cache").some((button) => button.disabled)).toBe(false);
  });

  it(`§13 · an item row's radio is checked at the DIRECT entry's mode — the set's own tool/<name>, prompt/<name> or resource/<uri> — and at none when the set holds no direct entry for that item, the row reading "also via <roles>" when a role matches it too (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const direct = await page(paths.agentApp("direct", "feed"), cookie);
    expect(checkedIn(direct, "tool/get_weather")).toBe("approval");
    expect(checkedIn(direct, "tool/get_news")).toBe("none");
    expect(checkedIn(direct, "prompt/daily_digest")).toBe("none");
    expect(checkedIn(direct, "resource/news://feed/latest")).toBe("none");

    // The twin: a direct entry on an item a role ALSO matches says so, and is still what
    // the radio is checked at.
    const both = await page(paths.agentApp("both", "feed"), cookie);
    expect(checkedIn(both, "tool/get_news")).toBe("approval");
    expect(textOf(both)).toContain("also via reader");
  });

  it(`§13 · a direct entry at ask under a role that allows draws the "ask entry · no effect" badge, titled "allow wins over ask", beside a × button submitting drop=<entry> · the same entry with no role allowing it draws neither the badge nor the × (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const both = await page(paths.agentApp("both", "feed"), cookie);
    expect(textOf(both)).toContain("ask entry · no effect");
    expect(both).toContain('title="allow wins over ask"');
    expect(dropOffers(both)).toContain("tool/get_news");

    // The twin: the same shape of entry with nothing allowing over it is an ordinary ask.
    const direct = await page(paths.agentApp("direct", "feed"), cookie);
    expect(textOf(direct)).not.toContain("ask entry · no effect");
    expect(dropOffers(direct)).not.toContain("tool/get_weather");
  });

  it(`§13 · a held role the app has not declared is its own row — the name, an undeclared badge and "granted, but the app has not declared it — dormant" — whose control is an "in Allowed" / "in Ask first" badge with a × remove button, never a radio group (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const quiet = await page(paths.agentApp("dormant", "silent"), cookie);
    const text = textOf(quiet);
    expect(text).toMatch(/triage\s+undeclared/);
    expect(text).toContain("granted, but the app has not declared it — dormant");
    expect(text).toContain("in Allowed");
    expect(dropOffers(quiet)).toContain("triage");
    // The twin: it is not a choice, so the row draws no radio group — the entry rides a
    // hidden field, which is what keeps a save from silently dropping it.
    expect(() => segOf(quiet, "triage")).toThrow();
    expect(quiet).toContain('name="e.triage" value="allow"');
  });

  it(`§13 · an inline entry whose pattern is not one literal item is a Patterns · N row reading "matches N today" / "matches nothing today" with a radio group of its own · a q that is not a literal name offers "As a pattern": one row tool/<q> (resource/<q> when q holds "://") over "would match N today, and any added later" / "matches nothing today", with the two submits Ask and Allow carrying add=<entry> and mode=approval | allow (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const direct = await page(paths.agentApp("direct", "feed"), cookie);
    expect(textOf(direct)).toContain("tool/purge_.*");
    expect(textOf(direct)).toContain("matches 1 today");
    expect(segOf(direct, "tool/purge_.*").map((button) => button.value)).toEqual(["none", "approval", "allow"]);

    // The twin: a filter that is not a name is offered as a pattern, with both modes as
    // submits of the pane's own form.
    const base = paths.agentApp("viarole", "feed");
    const offered = await page(`${base}?q=${encodeURIComponent("get_*")}`, cookie);
    expect(textOf(offered)).toContain("As a pattern");
    expect(textOf(offered)).toContain("would match 2 today, and any added later");
    for (const [mode, label] of [["allow", "Allow"], ["approval", "Ask"]] as const) {
      const press = clickedSubmission(offered, mode);
      expect(press.fields.add, label).toBe("tool/get_*");
      expect(press.fields.mode, label).toBe(mode);
    }
    // A `q` carrying a URI is a resource pattern, never a tool one.
    const uri = await page(`${base}?q=${encodeURIComponent("news://feed/*")}`, cookie);
    expect(textOf(uri)).toContain("resource/news://feed/*");
  });

  it(`§13 · with q set the rows are filtered by name or description substring while the pattern rows stay · a q that matches no row at all renders "Nothing matches “<q>”." (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const base = paths.agentApp("direct", "feed");
    const filtered = textOf(await page(`${base}?q=forecast`, cookie));
    // Matched on the DESCRIPTION, which is why the row it names is the weather one.
    expect(filtered).toContain("get_weather");
    expect(filtered).not.toContain("get_news");
    // A held pattern is not a row the filter can narrow, so it stays.
    expect(filtered).toContain("tool/purge_.*");

    // The twin: nothing at all — read on a set holding no pattern of its own, since a
    // pattern row is not a row the filter can empty.
    const nothing = await page(`${paths.agentApp("viarole", "feed")}?q=zzz`, cookie);
    expect(textOf(nothing)).toContain("Nothing matches “zzz”.");
  });

  it(`§13/§8 · Save composes every e.<entry> radio into ONE grant_set for the pair — allow bare, approval suffixed :approval, none dropped — merging the offer's add=<entry> at its mode and removing every drop=<entry>, replacing the pair's whole set and landing 303 on the pane with the notice (the twin)`, async () => {
    const { ns, cookie } = await seedWritablePair();
    const pane = paths.agentApp("claude", "feed");
    const action = paths.agentGrantSet("claude", "feed");
    const html = await page(pane, cookie);
    expect(await grantsOn(ns.owner.userId, "claude", "feed")).toEqual([
      "reader",
      "tool/get_news:approval",
      "tool/purge_.*",
    ]);

    // Pressed ×: the same composition, minus that one entry.
    const dropped = await formPost(
      action,
      { ...pressed(html, action, "drop", "tool/get_news"), csrf: csrfOf(html) },
      cookie,
    );
    expect(dropped.status).toBe(303);
    expect(await grantsOn(ns.owner.userId, "claude", "feed")).toEqual(["reader", "tool/purge_.*"]);

    // Pressed Allow on the pattern offer: the same composition, plus the offered entry.
    const offered = await page(`${pane}?q=${encodeURIComponent("get_*")}`, cookie);
    const added = await formPost(action, { ...pressed(offered, action, "mode", "allow"), csrf: csrfOf(offered) }, cookie);
    expect(added.status).toBe(303);
    expect(await grantsOn(ns.owner.userId, "claude", "feed")).toEqual(["reader", "tool/get_*", "tool/purge_.*"]);

    // Pressed Save, with three rows changed: a role dropped, a role added bare, and an
    // item added at ask — the whole set, replaced by what the page showed.
    const again = await page(pane, cookie);
    const saved = await formPost(
      action,
      {
        ...paneSubmission(again, action),
        "e.reader": "none",
        "e.purger": "allow",
        "e.tool/get_weather": "approval",
        csrf: csrfOf(again),
      },
      cookie,
    );
    expect(saved.status).toBe(303);
    const landing = new URL(saved.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(pane);
    expect(landing.searchParams.get("done")).toBe("grant_set");
    expect(await grantsOn(ns.owner.userId, "claude", "feed")).toEqual([
      "purger",
      "tool/get_*",
      "tool/get_weather:approval",
      "tool/purge_.*",
    ]);
  });

  it(`§13/§9 · a refused save — a proxied app's undeclared role, or a pattern that compiles to nothing valid — redraws the pane at 400 with the reason in a danger alert above the listing and every submitted choice preserved, never a redirect, leaving the saved set untouched (the twin)`, async () => {
    const scenario = await paneScenario();
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: "feed",
          kind: "proxy",
          name: "News MCP",
          upstreamUrl: upstreamUrlFor(scenario),
          upstreamAuthMode: "headers",
          capabilities: ["tools", "prompts", "resources"],
          // Declared at seed time so the grant below is legal, then withdrawn — the only
          // way a proxied app can hold an undeclared grant, and the state §13 draws.
          roles: { ...PANE_ROLES, triage: { tools: ["purge_.*"] } },
        },
      ],
      agents: [
        { slug: "claude", grants: { feed: [{ role: "reader", mode: "allow" }, { role: "triage", mode: "allow" }] } },
      ],
    });
    await ops.app_update.handler(ns.owner.userId, { slug: "feed", roles: PANE_ROLES });
    const cookie = (await seedOwnerSession(ns.owner)).cookie;
    const pane = paths.agentApp("claude", "feed");
    const action = paths.agentGrantSet("claude", "feed");
    const html = await page(pane, cookie);

    const refused = await formPost(
      action,
      { ...paneSubmission(html, action), "e.purger": "approval", csrf: csrfOf(html) },
      cookie,
    );
    // Redrawn here rather than landed anywhere, with the choices the submission carried.
    expect(refused.status).toBe(400);
    const redrawn = await refused.text();
    expect(redrawn).toContain(`action="${action}"`);
    expect(textOf(redrawn)).toContain("triage");
    expect(checkedIn(redrawn, "purger")).toBe("approval");
    expect(await grantsOn(ns.owner.userId, "claude", "feed")).toEqual(["reader", "triage"]);

    // The twin: a pattern that compiles to nothing valid is refused the same way — on a
    // pair holding nothing else that could be refused first.
    const clean = await seedWritablePair();
    const cleanAction = paths.agentGrantSet("claude", "feed");
    const offered = await page(`${paths.agentApp("claude", "feed")}?q=${encodeURIComponent("(")}`, clean.cookie);
    const bad = await formPost(
      cleanAction,
      { ...pressed(offered, cleanAction, "mode", "allow"), csrf: csrfOf(offered) },
      clean.cookie,
    );
    expect(bad.status).toBe(400);
    expect(textOf(await bad.text())).toContain('entry "tool/(" is not a valid pattern');
    expect(await grantsOn(clean.ns.owner.userId, "claude", "feed")).toEqual([
      "reader",
      "tool/get_news:approval",
      "tool/purge_.*",
    ]);
  });

  it(`§13 · Remove from <agent> opens ?confirm=remove-app on the pane — "Remove <app> from <agent>?" over "<agent> loses every entry on <app>. History stays; a waiting request expires." — whose form posts clear=1 to the same action, writing grant_set an empty set and landing 303 on /agents/<slug> with the notice (the twin)`, async () => {
    const { ns, cookie } = await seedWritablePair();
    const pane = paths.agentApp("claude", "feed");
    const bare = await page(pane, cookie);
    expect(links(bare, `${pane}?confirm=remove-app`)).toBe(true);

    const dialog = await page(`${pane}?confirm=remove-app`, cookie);
    expect(dialog).toContain("<dialog");
    expect(textOf(dialog)).toContain("Remove feed from claude?");
    expect(textOf(dialog)).toContain("claude loses every entry on feed. History stays; a waiting request expires.");
    expect(
      formsRenderedOn(dialog).some((form) => form.op === "grant_set" && form.fields.includes("clear")),
    ).toBe(true);

    const cleared = await formPost(
      paths.agentGrantSet("claude", "feed"),
      { clear: "1", csrf: csrfOf(dialog) },
      cookie,
    );
    expect(cleared.status).toBe(303);
    const landing = new URL(cleared.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(paths.agentDetail("claude"));
    expect(landing.searchParams.get("done")).toBe("grant_set");
    expect(await grantsOn(ns.owner.userId, "claude", "feed")).toEqual([]);
  });

  it(`§13 · the details pane answers sel: a role draws the role badge, "Declared by <app> at connect." / "Built in: every family, present and future.", its For-agent, Patterns and "Matches today" cards; a tool draws its Standing, the approval sentence, the Arguments table and "Called as <app>_<tool> on the aggregated endpoint"; a pattern draws the pattern badge, "An entry that is not one item: anchored, * aliases .*." and "Matches today · N" · nothing selected draws "Select a role, tool, prompt or resource on the left for its details." with the Catalog and "Grant set for <agent>" cards (the twin)`, async () => {
    const { cookie } = await withGrantPane();
    const base = paths.agentApp("viarole", "feed");

    const role = textOf(await page(`${base}?sel=role:reader`, cookie));
    expect(role).toContain("Patterns");
    expect(role).toContain("Matches today");
    expect(role).toContain("get_news");
    expect(role).toContain(
      "A role widens when the app widens it. To keep a single item regardless, add it directly from its row.",
    );
    expect(textOf(await page(`${base}?sel=role:all`, cookie))).toContain(
      "Built in: every family, present and future.",
    );

    const tool = textOf(await page(`${base}?sel=tool:get_news`, cookie));
    expect(tool).toContain("Fetch the latest stories.");
    expect(tool).toContain("Called as feed_get_news on the aggregated endpoint");

    const pattern = textOf(
      await page(`${paths.agentApp("direct", "feed")}?sel=pattern:${encodeURIComponent("tool/purge_.*")}`, cookie),
    );
    // The sentence ends in the code span `.*`, and `textOf` takes the space off in front
    // of the full stop that follows it — the string a reader sees, spelled as they see it.
    expect(pattern).toContain("An entry that is not one item: anchored, * aliases");
    expect(pattern).toContain("Matches today · 1");

    // The twin: nothing selected is the app's own summary, not an empty column.
    const nothing = textOf(await page(base, cookie));
    expect(nothing).toContain("Select a role, tool, prompt or resource on the left for its details.");
    expect(nothing).toContain("Grant set for viarole");
  });

  it(`§13 · a description is the Markdown an app wrote it in (2026-09-16): the listing row renders its FIRST paragraph inline and stays one line, the details pane renders it whole — a fence as <pre><code>, a list as <ul>, and an http link carrying rel="noopener noreferrer" target="_blank" — while the app's own markup never becomes markup: a javascript: link renders as its text and a literal <script> arrives escaped · the grant step's endpoint title, which can hold text alone, carries the same description with the Markdown taken off (the twin)`, async () => {
    // Its own namespace: the shared pane world's counts ("reaches 2 of 3 tools") are read
    // by the rows above, and a fourth tool would move every one of them.
    const { cookie, pane, grant } = await seedMarkdownPane();
    const html = await page(`${pane}?sel=tool:md_notes`, cookie);

    // The ROW, whole and exact: the inline marks render, and nothing the description's
    // later blocks contain can make a one-line row taller.
    expect(html).toContain(
      '<div class="cr-detail md">Draft the <strong>weekly</strong> note from <code>notes://inbox</code>.</div>',
    );

    // The details pane, the same description whole.
    expect(html).toContain("<pre><code>");
    expect(html).toContain("<ul>");
    expect(html).toContain('<a href="https://example.com/docs" rel="noopener noreferrer" target="_blank">handbook</a>');

    // Neutralised, both ways: the refused scheme survives as words with no anchor around
    // them, and the app's tag arrives as the four characters it is.
    expect(html).not.toContain("javascript:");
    expect(textOf(html)).toContain("run it");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");

    // The twin: an attribute holds text alone, so the grant step's info marker carries the
    // description with the Markdown off — no marks, no markup, one line.
    const step = await page(`${grant}?show=mdfeed`, cookie);
    const title = /<span class="ep-info" title="([^"]*)"/.exec(step)?.[1] ?? "";
    expect(title).toContain("Draft the weekly note from notes://inbox.");
    expect(title).not.toContain("**");
    expect(title).not.toContain("<strong>");
    expect(step).not.toContain("<script>alert(1)</script>");
  });
});

/* ------------------------------------------------------------------ *
 * The agent pages' own reading: the rail, one row's control, and the two seeded worlds.
 * ------------------------------------------------------------------ */

/** The four fields the app pane's form carries that are NOT one row's choice — the ones
 *  the route composes into `grant_set`'s `roles` rather than passing through. */
const COMPOSED_GRANT_FIELDS: ReadonlySet<string> = new Set(["add", "mode", "drop", "clear"]);

/** The agent rail's accessible name, discovered rather than spelled: it is the navigation
 *  that carries this agent's Danger zone and is not the compact one. Finding it by what it
 *  links keeps every rail row about the rail's CONTENT, never about its label. */
function agentRailLabel(html: string, slug: string): string {
  const danger = `href="${paths.agentPane(slug, "danger")}"`;
  for (const nav of html.matchAll(/<nav\b[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/nav>/g)) {
    if (nav[2].includes(danger) && !nav[1].endsWith("compact")) return nav[1];
  }
  throw new Error("the page rendered no agent rail");
}

/** The agent rail's markup, for the group headings a rail entry walk cannot see. */
function agentRailBlock(html: string, slug: string): string {
  return navBlock(html, agentRailLabel(html, slug)) ?? "";
}

/** The agent rail's entries, in the order it drew them. */
function agentRail(html: string, slug: string): RailEntry[] {
  return railEntries(html, agentRailLabel(html, slug));
}

/** One rail entry's own markup — where the two markers that are not text live (the amber
 *  dot, the dimmed link), which is the only place they exist at all. */
function railAnchor(html: string, slug: string, href: string): string {
  const anchor = [...agentRailBlock(html, slug).matchAll(/<a\b([^>]*)>[\s\S]*?<\/a>/g)].find(
    (candidate) => decodeEntities(attributeOf(candidate[1], "href") ?? "") === href,
  );
  if (anchor === undefined) throw new Error(`the agent rail carries no entry for "${href}"`);
  return anchor[0];
}

/**
 * The level header the narrow agent page draws above its content (2026-09-16): its back
 * link — the one anchor whose text opens with §13's `‹` — and the title beside it.
 *
 * Read off the anchor and the text that FOLLOWS it rather than off a class, because which
 * element carries the header and how it is centred are CSS's business; what the brief pins
 * is where the link goes, what it names, and what the header calls the current thing. The
 * window is bounded so the title is the header's own and not the page's next sentence.
 */
function levelHeader(html: string): { back: string; href: string; title: string } {
  const back = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].find((anchor) =>
    textOf(anchor[2]).startsWith("‹"),
  );
  if (back === undefined) throw new Error("the page rendered no level header");
  const rest = html.slice((back.index ?? 0) + back[0].length);
  const closes = rest.indexOf("</div>");
  const after = rest.slice(0, closes < 0 ? 200 : Math.min(closes, 200));
  return {
    back: textOf(back[2]),
    href: decodeEntities(attributeOf(back[1], "href") ?? ""),
    title: textOf(after),
  };
}

/** One row's control as the browser sees it: the radios named `e.<entry>`, in the order
 *  they are drawn, each with the three attributes that decide what a click can do. */
function segOf(html: string, entry: string): { value: string; checked: boolean; disabled: boolean }[] {
  const name = `e.${entry}`;
  const buttons: { value: string; checked: boolean; disabled: boolean }[] = [];
  for (const control of html.matchAll(/<input\b([^>]*)>/g)) {
    if (decodeEntities(attributeOf(control[1], "name") ?? "") !== name) continue;
    // RADIOS only: a row whose entry is not a choice carries its entry in a hidden field
    // instead, and "that row offers no choice" must not read as "it offers one".
    if (attributeOf(control[1], "type") !== "radio") continue;
    buttons.push({
      value: decodeEntities(attributeOf(control[1], "value") ?? ""),
      checked: /\bchecked\b/.test(control[1]),
      disabled: /\bdisabled\b/.test(control[1]),
    });
  }
  if (buttons.length === 0) throw new Error(`the pane rendered no control named "${name}"`);
  return buttons;
}

/** Which of one row's three buttons the page checked — `null` when it checked none, which
 *  is a different claim from "checked at none" and must not read as one. */
function checkedIn(html: string, entry: string): string | null {
  return segOf(html, entry).find((button) => button.checked)?.value ?? null;
}

/** The entries the pane offers to remove: one `drop` submit per × button. */
function dropOffers(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>/g)]
    .filter((button) => attributeOf(button[1], "name") === "drop")
    .map((button) => decodeEntities(attributeOf(button[1], "value") ?? ""));
}

/**
 * The app pane's form as a browser would submit it untouched: every hidden field, and each
 * radio group at the option the page CHECKED — a browser sends one value per group, which
 * `submissionOf` (written for text and checkbox controls) cannot say, and without which
 * "Save replaces the set with what the page showed" would be untestable.
 */
function paneSubmission(html: string, action: string): Record<string, string> {
  const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find(
    (candidate) => decodeEntities(attributeOf(candidate[1], "action") ?? "") === action,
  );
  if (form === undefined) throw new Error(`the page rendered no form posting to "${action}"`);
  const fields: Record<string, string> = {};
  for (const control of form[2].matchAll(/<input\b([^>]*)>/g)) {
    const name = decodeEntities(attributeOf(control[1], "name") ?? "");
    if (name === "") continue;
    const value = decodeEntities(attributeOf(control[1], "value") ?? "");
    if (attributeOf(control[1], "type") === "radio") {
      if (/\bchecked\b/.test(control[1])) fields[name] = value;
      continue;
    }
    fields[name] = value;
  }
  return fields;
}

/** One PRESS of a named submit button on that form: the form's own controls plus the
 *  button's name and value, because a browser sends the button that was pressed and no
 *  other. Throws when the page drew no such button — a submission the page cannot make
 *  proves nothing. */
function pressed(html: string, action: string, name: string, value: string): Record<string, string> {
  const button = [...html.matchAll(/<button\b([^>]*)>/g)].find(
    (candidate) =>
      attributeOf(candidate[1], "name") === name &&
      decodeEntities(attributeOf(candidate[1], "value") ?? "") === value,
  );
  if (button === undefined) throw new Error(`the pane rendered no "${name}" button valued "${value}"`);
  return { ...paneSubmission(html, action), [name]: value };
}

/** The values one `<select>` offers, in the order it offers them. */
function optionValues(body: string): string[] {
  return [...body.matchAll(/<option\b([^>]*)>/g)].map((option) => decodeEntities(attributeOf(option[1], "value") ?? ""));
}

/** One pair's grants as `agent_list` spells them, sorted — the postcondition every save
 *  row reads, through the op and never off the table. */
async function grantsOn(ownerId: string, agent: string, app: string): Promise<string[]> {
  const listed = (await ops.agent_list.handler(ownerId, {})) as {
    agents: { slug: string; grants: Record<string, string[]> }[];
  };
  return [...(listed.agents.find((row) => row.slug === agent)?.grants[app] ?? [])].sort();
}

/**
 * The catalog every grant-pane fixture reads: three tools (two of them behind one pattern),
 * one prompt and one resource, plus two roles — a pattern role that reaches most of it and a
 * literal role that reaches the one tool the other does not. That shape is what makes "via
 * <role>", "direct" and "reaches N of T" three different readings of one page.
 */
const PANE_TOOLS = [
  {
    name: "get_news",
    description: "Fetch the latest stories.",
    inputSchema: { type: "object", properties: { q: { type: "string", description: "The query." } }, required: ["q"] },
  },
  { name: "get_weather", description: "Fetch the forecast.", inputSchema: { type: "object" } },
  { name: "purge_cache", description: "Drop the cache.", inputSchema: { type: "object" } },
];
const PANE_PROMPTS = [{ name: "daily_digest", description: "The day's digest.", arguments: [] }];
const PANE_RESOURCES = [{ uri: "news://feed/latest", name: "Latest headlines", mimeType: "text/plain" }];
const PANE_ROLES = {
  reader: { tools: ["get_.*"], prompts: ["daily_.*"], resources: ["news://feed/*"] },
  purger: { tools: ["purge_cache"] },
};

/** One fake upstream serving that catalog — registered per fixture, so two namespaces'
 *  payloads can never collide. */
async function paneScenario(): Promise<UpstreamScenario> {
  const scenario: UpstreamScenario = { id: uniqueSlug("paneup"), mode: { kind: "ok" } };
  await registerOverride(scenario.id, { tools: PANE_TOOLS, prompts: PANE_PROMPTS, resources: PANE_RESOURCES });
  return scenario;
}

/**
 * §13's Markdown rule (2026-09-16) as an app would actually write a description: inline
 * marks, a fence, a list, a link the whitelist admits, one it must refuse, and a raw tag.
 * ONE source for both pages' rows, because it is one renderer (server/src/pages/markdown.ts)
 * — a description that rendered one way on the app page and another on the agent page would
 * be two whitelists, which is the shape this whole seam exists to prevent.
 *
 * The fence names no tool on purpose: the app page's own row counts how often each tool
 * name is NAMED, and a name inside a description would be a second mention of it.
 */
const MARKDOWN_DESCRIPTION = [
  "Draft the **weekly** note from `notes://inbox`.",
  "",
  "```sh",
  "notes --since 7d",
  "```",
  "",
  "- newest first",
  "- capped at 50",
  "",
  "See the [handbook](https://example.com/docs), or [run it](javascript:alert(1)).",
  "",
  "<script>alert(1)</script>",
].join("\n");

const MARKDOWN_TOOL = { name: "md_notes", description: MARKDOWN_DESCRIPTION, inputSchema: { type: "object" } };

/** A namespace of its own for the Markdown row: one proxied app advertising that one tool,
 *  the agent holding it (the listing and its details pane) and one holding nothing at all
 *  (the grant step, the one place the description becomes an attribute). Its own rather
 *  than the shared pane world's, whose counts every row above reads. */
async function seedMarkdownPane(): Promise<{ cookie: string; pane: string; grant: string }> {
  const scenario: UpstreamScenario = { id: uniqueSlug("mdup"), mode: { kind: "ok" } };
  await registerOverride(scenario.id, { tools: [MARKDOWN_TOOL] });
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "mdfeed",
        kind: "proxy",
        name: "Markdown MCP",
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers",
        capabilities: ["tools"],
        roles: { reader: { tools: ["md_.*"] } },
      },
    ],
    agents: [
      { slug: "claude", grants: { mdfeed: [{ role: "reader", mode: "allow" }] } },
      { slug: "fresh", grants: {} },
    ],
  });
  return {
    cookie: (await seedOwnerSession(ns.owner)).cookie,
    pane: paths.agentApp("claude", "mdfeed"),
    grant: paths.agentPane("fresh", "grant"),
  };
}

type AgentWorld = { ns: SeededNamespace; cookie: string };

/**
 * The agent page's own world, seeded ONCE and awaited from each row that reads it: four
 * apps (one grantable, one plain grant, one that asks first, one archived) and three agents
 * (one holding three grants, one holding none, one holding every active app). Memoized
 * rather than hung off a hook, because `-t` naming one row must still seed it — and shared
 * because these rows only READ: the rows that write seed their own.
 */
let agentPanesWorld: Promise<AgentWorld> | null = null;
const withAgentPanes = (): Promise<AgentWorld> => (agentPanesWorld ??= seedAgentPanes());

async function seedAgentPanes(): Promise<AgentWorld> {
  const scenario = await paneScenario();
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "brand",
        kind: "proxy",
        name: "Brand",
        description: "The brand app.",
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers",
        capabilities: ["tools", "prompts", "resources"],
        roles: { reader: { tools: ["get_.*"] } },
      },
      { slug: "linear", kind: "tunnel", name: "Linear" },
      { slug: "news", kind: "tunnel", name: "News MCP" },
      { slug: "parked", kind: "tunnel", archived: true },
    ],
    agents: [
      {
        slug: "claude",
        name: "Claude",
        description: "Claude sessions",
        grants: {
          linear: [{ role: "reader", mode: "allow" }],
          news: [{ role: "reader", mode: "approval" }],
          parked: [{ role: "all", mode: "allow" }],
        },
        tokens: [{ as: "claude" }],
      },
      { slug: "cron", grants: {} },
      {
        slug: "everywhere",
        grants: {
          brand: [{ role: "reader", mode: "allow" }],
          linear: [{ role: "reader", mode: "allow" }],
          news: [{ role: "reader", mode: "allow" }],
        },
      },
    ],
  });
  // The two tunneled apps have connected once, so their roles are declared and the header's
  // dormant count is about the archived app alone (seed FINDINGS 1).
  const registry = new Registry(env.DB);
  await registry.upsertDeclaredRoles(ns.apps.linear.id, { reader: ["get_.*"] });
  await registry.upsertDeclaredRoles(ns.apps.news.id, { reader: ["get_.*"] });
  return { ns, cookie: (await seedOwnerSession(ns.owner)).cookie };
}

/**
 * The grant pane's world: one proxied app with a catalog, one tunneled app that has never
 * connected, and five agents — one reaching through a role, one through the same role at
 * ask, one holding inline items only, one holding both, and one holding a role its app has
 * never declared. Every state the listing draws, as a grant set.
 */
let grantPaneWorld: Promise<AgentWorld> | null = null;
const withGrantPane = (): Promise<AgentWorld> => (grantPaneWorld ??= seedGrantPane());

async function seedGrantPane(): Promise<AgentWorld> {
  const scenario = await paneScenario();
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "feed",
        kind: "proxy",
        name: "News MCP",
        description: "The newsroom's own app.",
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers",
        capabilities: ["tools", "prompts", "resources"],
        roles: PANE_ROLES,
      },
      { slug: "silent", kind: "tunnel", name: "Silent app" },
    ],
    agents: [
      { slug: "viarole", grants: { feed: [{ role: "reader", mode: "allow" }] } },
      { slug: "askrole", grants: { feed: [{ role: "reader", mode: "approval" }] } },
      {
        slug: "direct",
        grants: {
          feed: [
            { role: "tool/get_weather", mode: "approval" },
            { role: "tool/purge_.*", mode: "allow" },
          ],
        },
      },
      {
        slug: "both",
        grants: {
          feed: [
            { role: "reader", mode: "allow" },
            { role: "tool/get_news", mode: "approval" },
          ],
        },
      },
      { slug: "dormant", grants: { silent: [{ role: "triage", mode: "allow" }] } },
    ],
  });
  return { ns, cookie: (await seedOwnerSession(ns.owner)).cookie };
}

/** One fresh namespace of the same shape, for the rows that WRITE: a save is not a read,
 *  and the rows above share one seeding. */
async function seedWritablePair(): Promise<AgentWorld> {
  const scenario = await paneScenario();
  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: "feed",
        kind: "proxy",
        name: "News MCP",
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "headers",
        capabilities: ["tools", "prompts", "resources"],
        roles: PANE_ROLES,
      },
    ],
    agents: [
      {
        slug: "claude",
        grants: {
          feed: [
            { role: "reader", mode: "allow" },
            // An ask entry under an allowing role, so the pane draws the one × a save row
            // can press, and a pattern, so it draws a Patterns row to preserve.
            { role: "tool/get_news", mode: "approval" },
            { role: "tool/purge_.*", mode: "allow" },
          ],
        },
      },
    ],
  });
  return { ns, cookie: (await seedOwnerSession(ns.owner)).cookie };
}

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

describe(`§13 · the /settings shell — six panes behind one rail`, () => {
  it(`§13 · each of the six settings panes answers at its own URL and /settings renders the Password pane · /settings/password is a 404, not an alias and not a redirect (the twin: the five other pane URLs all answer 200)`, async () => {
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

  it(`§13 · every pane renders the same rail — six entries under Sign-in and Access, in the sign-in-then-holdings order, each linking to its own pane URL — the Password entry carries no marker where the five others do, and the entry for the pane being rendered is the only rail entry carrying aria-current="page"`, async () => {
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
      // §13's pane table: Password's marker cell reads `none`. The five beside it are what
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
  it(`§4/§13 · the /settings gate is a prefix rule: a stale cookie and a bearer-sourced session are refused on all six panes, the two ops-backed ones included · the same six panes render on a session signed in moments ago (the twin)`, async () => {
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
    expect(walked, "the walk did not cover six panes").toBe(6);
  });

  it(`§4/§13 · every POST target under /settings/ refuses a day-old cookie carrying its own real CSRF token and never reaches its op — the credential targets and the two ops-backed panes' alike · the same posts from a fresh session are accepted (the twin)`, async () => {
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
    const staleCsrf = csrfOf(await page(paths.apps, stale.cookie));
    const freshCsrf = csrfOf(await page(paths.apps, fresh.cookie));
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

  it(`§13 · the six pane routes are the six strings §13 spells — /settings, /settings/two-factor, /settings/passkeys, /settings/sessions, /settings/tokens, /settings/clients — asserted against the literals once, since every other row reads them through paths`, () => {
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
    ]).toEqual([
      "/settings",
      "/settings/two-factor",
      "/settings/passkeys",
      "/settings/sessions",
      "/settings/tokens",
      "/settings/clients",
    ]);
  });

  it(`§13 · no rendered page links /oauth/consent — it is chromeless and has no nav slot, by design · the same pages link all six settings panes (the twin)`, async () => {
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

  it(`§13 · the mobile pill row lists the same six pane URLs in the same order as the rail, markerless, and shortens only the last label, to Clients — structure only, nothing visual`, async () => {
    for (const pane of PANES) {
      const html = await page(pane);
      const rail = railEntries(html, RAIL_NAV_LABEL);
      const pills = railEntries(html, PILL_NAV_LABEL);
      expect(pills.map((e) => e.href), `the pill row on ${pane}`).toEqual(rail.map((e) => e.href));
      expect(pills.map((e) => e.href), `the pill row on ${pane}`).toEqual(PANES);
      // §13: "label only, no markers".
      expect(pills.map((e) => e.marker), `the pill row on ${pane}`).toEqual(PANES.map(() => ""));
      for (let at = 0; at < 5; at += 1) {
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

  it(`§13 · nothing is added TO the consent screen either: /oauth/consent renders neither paned page's rail and neither pill row — chromeless, no nav slot · the same helpers find the six entries on a settings pane (the twin)`, async () => {
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
    // helper finds six entries on a settings pane in this same case.
    expect(railEntries(await page(paths.settings, session.cookie), RAIL_NAV_LABEL).length).toBe(6);
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

  it(`§4 · better-auth's own /change-password mount enforces no freshness, so the hub's recent-auth gate is the only one the change has: a day-old cookie posting JSON straight at /api/auth/change-password is judged on the password it named, while the same cookie at /settings/change-password never reaches it`, async () => {
    // §4's "That gate is load-bearing, not belt-and-braces" made falsifiable: without this
    // pair, "the only freshness check" is indistinguishable from better-auth having one.
    // One app, because /apps is where a session with no recency left can still read its
    // own CSRF token and a namespace with no rows draws no form to read one off.
    const ns = await seedNamespace(env.DB, { apps: [{ slug: uniqueSlug("pwgate"), kind: "tunnel" }] });
    const stale = await seedOwnerSession(ns.owner);
    const fresh = await seedOwnerSession(ns.owner);
    await ageSession(stale.token);
    const wanted = fakePassword(20);

    // LEG A: straight at better-auth's own mount, no Authorization header (so the
    // BEARER_ADMITTED guard never fires) — judged on the password, not on the age.
    const direct = await call(
      new Request(`${ORIGIN}${AUTH_BASE_PATH}/change-password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: ORIGIN, Cookie: stale.cookie },
        body: JSON.stringify({ currentPassword: SEEDED_OWNER_PASSWORD, newPassword: wanted }),
      }),
    );
    expect(direct.status, await direct.text()).toBe(200);
    expect(await signsIn(ns.owner.username, wanted)).toBe(true);

    // Reseeded so neither leg's success can mask the other's.
    await seedOwnerCredential(ns.owner.userId);

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
        csrf: csrfOf(await page(paths.apps, stale.cookie)),
      },
      stale.cookie,
    );
    expect(gated.status).toBe(302);
    expect(gated.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);
    expect(await signsIn(ns.owner.username, SEEDED_OWNER_PASSWORD)).toBe(true);
  });

  it(`§4 · the day-old cookie that can post none of /settings's credential targets cannot post Update password either — the action read off the rendered pane, walked stale and fresh · a session signed in moments ago reaches better-auth with the same body (the twin)`, async () => {
    // One app for the same reason row 26 has one: /apps is where a stale session can
    // still read its own CSRF token, and an empty namespace draws no form there.
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
      { ...body, csrf: csrfOf(await page(paths.apps, stale.cookie)) },
      stale.cookie,
    );
    expect(refused.status).toBe(302);
    expect(refused.headers.get("Location") ?? "").toMatch(/^\/login(\?|$)/);

    const reached = await formPost(
      target,
      { ...body, csrf: csrfOf(await page(paths.apps, fresh.cookie)) },
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

    // The totality half §13 actually pins: nothing the six panes render points under the
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

/* ------------------------------------------------------------------ *
 * /apps/<slug> — the world the header and Tools rows are written against
 * ------------------------------------------------------------------ */

/**
 * The six apps this describe holds. Their slugs are CONSTS because `seedNamespace` keys
 * its apps by slug and every row addresses them that way; `uniqueSlug` because a tool
 * name asserted "exactly once" must not be able to collide with another file's fixture.
 *
 * CATALOG is the rich proxied app every listing row runs against; PLAIN is the proxied
 * app that declared no `capabilities` at all (§20.2's "absent ≡ [tools]"); TUNNELAPP and
 * FRESHAPP are the stamped and never-connected tunneled pair the header rows compare;
 * BROKEN is the oauth app driven into `needs_reconnect`; DOWN is the proxied app whose
 * upstream cannot be dialled at all.
 */
const CATALOG = uniqueSlug("catalog");
const PLAIN = uniqueSlug("plain");
const TUNNELAPP = uniqueSlug("tunnelapp");
const FRESHAPP = uniqueSlug("freshapp");
const BROKEN = uniqueSlug("broken");
const DOWN = uniqueSlug("down");

/** One upstream per proxied app, so two `registerOverride` payloads cannot collide.
 *  BROKEN's authorization server hands back a token that is already dead and then rejects
 *  the refresh it forces — the one pair §7 allows to reach `needs_reconnect`. DOWN's
 *  `unreachable` mode is expressed in the URL's SCHEME, so the hub's own fetch rejects and
 *  the fake is never dialled at all: the OTHER arm of the listing seam's failure catch. */
const catalogScenario: UpstreamScenario = { id: uniqueSlug("catup"), mode: { kind: "ok" } };
const plainScenario: UpstreamScenario = { id: uniqueSlug("plainup"), mode: { kind: "ok" } };
const brokenScenario: UpstreamScenario = {
  id: uniqueSlug("brkup"),
  mode: { kind: "ok" },
  as: { id: uniqueSlug("brkas"), quirks: ["stale_first_token", "refresh_fails"] },
};
const downScenario: UpstreamScenario = { id: uniqueSlug("downup"), mode: { kind: "unreachable" } };

/** §13's dimmed marker — the ONE value that means "advertises none". */
const DIMMED_MARKER = "—";

/** §13's Arguments table is read off THIS schema: one required string, one optional with
 *  a default, and one nested object whose own property must never reach the page. */
const PAPER_SCHEMA = {
  type: "object",
  properties: {
    doi: { type: "string" },
    force_refresh: { type: "boolean", default: false },
    options: { type: "object", properties: { depth: { type: "number" } } },
  },
  required: ["doi"],
};

/** §7's two redaction halves in one schema: a `writeOnly` mark the walk finds, and a
 *  plain path only the app's own `redact` config names. */
const SECRET_SCHEMA = {
  type: "object",
  properties: {
    credentials: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
    payload: { type: "object", properties: { key: { type: "string" } } },
  },
};

/** Indirection the hub refuses to resolve (§7, §18 decision 16) — asserted through
 *  `validateSchemaIndirection` before any page is read, so the fixture cannot quietly
 *  become sound. */
const BAD_SCHEMA = { type: "object", $ref: "https://schemas.pmcp-test.invalid/tool.json" };

const PAPER_SUMMARY = "Fetch the paper identified by a DOI and return its text as Markdown.";
const PAPER_DETAIL = "It must be the exact DOI string, not a URL or a padded value.";

const CATALOG_TOOLS = [
  { name: "paper_fetch", description: `${PAPER_SUMMARY}\n${PAPER_DETAIL}`, inputSchema: PAPER_SCHEMA },
  {
    name: "jobfeed_crawl",
    description: "Trigger a crawl of the configured boards.",
    inputSchema: { type: "object" },
  },
  { name: "secret_push", description: "Push a secret to the configured store.", inputSchema: SECRET_SCHEMA },
  { name: "bad_schema", description: "A tool the hub will not walk.", inputSchema: BAD_SCHEMA },
  // §13's Markdown rule (2026-09-16) — the same description the agent page's row reads.
  MARKDOWN_TOOL,
];
const CATALOG_TOOL_NAMES = CATALOG_TOOLS.map((tool) => tool.name);

/** One prompt `reader`'s `digest_.*` pattern reaches, carrying a declared argument, and
 *  one it does not — which is what makes "reachable by no agent yet" a claim about this
 *  prompt rather than about the fixture having no agents. */
const CATALOG_PROMPTS = [
  {
    name: "digest_daily",
    description: "The day's digest.",
    arguments: [{ name: "day", description: "Which day.", required: true }],
  },
  { name: "weekly_note", description: "A weekly note.", arguments: [] },
];
const CATALOG_PROMPT_NAMES = CATALOG_PROMPTS.map((prompt) => prompt.name);

/** The second row is §20.2's trap: its NAME matches `reader`'s `news://feed/*` pattern
 *  and its URI does not, which is the bug the URI-not-name rule was written to prevent. */
const CATALOG_RESOURCES = [
  { uri: "news://feed/latest", name: "Latest headlines", mimeType: "text/plain" },
  { uri: "news://archive/2021", name: "news://feed/decoy", mimeType: "application/json" },
];
/** Reached by the same `news://feed/*` — `*` aliases `.*`, and §20.3 makes the raw
 *  template an ordinary subject string rather than something the hub expands. */
const CATALOG_TEMPLATES = [
  { uriTemplate: "news://feed/{id}", name: "One story by id", mimeType: "text/plain" },
];
const CATALOG_RESOURCE_URIS = CATALOG_RESOURCES.map((row) => row.uri);
const CATALOG_TEMPLATE_URIS = CATALOG_TEMPLATES.map((row) => row.uriTemplate);

/** One literal role, one pattern role, and a third that overlaps the pattern — which is
 *  what makes "allow wins over approval per agent" (§2) observable on one tool. */
const CATALOG_ROLES = {
  reader: { tools: ["paper_fetch"], prompts: ["digest_.*"], resources: ["news://feed/*"] },
  crawler: ["jobfeed_.*"],
  both: { tools: ["jobfeed_crawl"] },
};

const PLAIN_TOOLS = [{ name: "plain_ping", description: "Answer.", inputSchema: { type: "object" } }];

/** The brief's sentences these rows pin (docs/superpowers/plans/2026-09-17-app-three-pane.md
 *  §2–§7, which §13 then records), spelled as it spells them — backticks included, so a
 *  reader can diff a literal against the spec; `pinned()` takes them off. */
const CATALOG_TUNNELED_SUB = "advertised by the app on its last connect · re-listed on every reconnect";
const CATALOG_PROXIED_SUB = "fetched live from the upstream";
const NEVER_CONNECTED = "This app has never connected, so the hub has no catalog to list yet.";
const REFRESH_FAILED = "Token refresh failed — calls return errors until you reconnect.";
const NONE_ADVERTISED = "none advertised";
const NO_MATCH = "no match";
const NO_AGENT = "no agent";
const CATALOG_PROMPT = "Select a tool, prompt or resource for its details.";
const REACH_SOURCE = "computed with the gate's own matcher over each agent's grant";
const MATCHED_BY_URI = "by URI, never by name";
const NO_AGENT_YET = "no agent yet";
const NO_REDACTED = "no redacted fields";
const NO_APPROVAL = "none required";
const NEVER_GATED = "never asked for prompts";

/** The unread / undeclared states, per kind, with the family or endpoint substituted
 *  exactly as the brief substitutes it. */
const unreachable = (endpoint: string): string =>
  `Couldn't reach ${endpoint} — the live listing failed, so nothing is shown; calls return errors until it answers again.`;
const tunneledUndeclared = (family: string): string =>
  `This app declared no ${family} capability on its last connect.`;
const proxiedOmits = (family: string): string =>
  `The \`capabilities\` configured for this app omit ${family}.`;
const catalogFoot = (family: string): string =>
  `The same block the audit row and the agent page show for this ${family}. Editing reach happens on Agents, masking on Recording.`;

/** §4 · the Roles pane. */
const ROLES_SUB = "named sets of what this app exposes";
const ROLES_TUNNELED_TAIL = "the app's declaration wins when it declares a name you defined";
const ROLES_PROXIED_TAIL = "a proxied app declares none, so every role is yours";
const ROLES_PROMPT = "Select a role to see what it can do, or add one of your own.";
const ROLE_REPLACED = "app · replaced yours";
const ROLE_REPLACED_TITLE = "the app declares this name — its declaration replaced yours";
const ROLE_ALL_ITEMS = "every tool, prompt and resource, present and future";
const HELD_BY_NONE = "held by no agent";
const ALL_EXPLAINED = "Every tool, prompt and resource, present and future. Never declarable, only grantable.";
const COLLISION_RULE =
  "if the app later declares a name you defined, its declaration replaces yours — the row says so";
const DELETE_ROLE_HINT = "grants naming it keep the name and match nothing until it exists again";
const PATTERNS_LEGEND = "anchored · * aliases .*";
const appRoleExplained = (name: string): string =>
  `Declared by ${name} at connect. Read-only: the app owns it and may widen it on its next connect.`;
const shadowedExplained = (name: string): string =>
  `${name} declares this name, so its declaration replaced the one you had defined. Read-only: the app owns it.`;
const yoursTunneled = (name: string, role: string): string =>
  `Defined by you. If ${name} later declares a role named ${role}, the app's declaration replaces this one.`;
const YOURS_PROXIED =
  "Defined by you. A proxied app declares no roles, so this is the only kind it has.";
const declaredByApp = (name: string): string =>
  `${name} is declared by the app — its declaration would replace yours`;

/** §5 · the Recording pane. */
const RECORDING_SUB = "what the audit trail keeps, and what it masks";
const RECORD_BODIES = "Record call bodies";
const PROXIED_UNMASKED =
  "A proxied app's schema is not cached at call time, so nothing is masked automatically. Tick what is secret before you save, or it is stored in the clear for 7 days.";
const MASKED_BEFORE =
  "These fields are replaced with ‹redacted› before a call is written to the trail. Everything else in the body is kept as sent.";
const LOGGING_OFF_NOTE =
  "Body logging is off, so no bodies reach the trail; the masks below apply once it is turned on.";
const RECORDING_NOTE =
  "A tick writes one literal (tool, path) entry per tool; nothing here is a pattern and nothing is typed. Masking applies to the approval record too.";
const KEEPS_CAP = "16 KiB per body — an over-cap body is one oversize stub";
const KEEPS_NEVER = "refused calls, token material, writeOnly and config-masked fields";
const ALWAYS_MASKED = "declared by the app — always masked";
const NO_PATH_MATCHES = "no path matches";
const NO_SCHEMA_FIELDS = "no schema declares any field";
const noOutputSchema = (tools: string): string =>
  `${tools} declare no output schema — a result path there can only come from a recorded call (mask from evidence).`;

/** §6 · the Agents pane. */
const AGENTS_SUB = "who can call this app, and how";
const AGENTS_NOTE =
  "Granting a new agent starts from the agent's own page — Agents → the agent → Grant another app.";
const agentsPrompt = (slug: string): string => `Select an agent to edit what it may call on ${slug}.`;
const grantLegend = (agent: string, slug: string): string =>
  `${agent}'s grant on ${slug}. Solid: set on the row · hollow: implied by a role · a row cannot lower what a role grants.`;
const removeAgentBody = (agent: string, slug: string): string =>
  `${agent} loses every entry on ${slug}. History stays; a waiting request expires.`;

/** §7 · Token and Overview. */
const TOKEN_SUB = "what the app presents to dial in";
const TOKEN_ROTATION =
  "app tokens have no expiry — rotate by issuing, then revoking the old one. Revoking the key a live socket used closes it.";
const NO_LIVE_TOKEN = "No live token — the app cannot connect until one is issued.";
const REVEAL_ONCE = "Shown once — copy it now";
const EXPIRES_NEVER = "never — revoke on compromise";
const tokenScope = (slug: string): string =>
  `Only valid for opening the reverse WebSocket as ${slug}.`;

/** §15's two per-kind defaults, as the Overview pane names them. */
const LOG_BODIES_TUNNEL = "On — tunneled default";
const LOG_BODIES_PROXY = "Off — proxied default";

/** The Catalog's own pane URL. `/apps/<slug>` is the LANDING — level 1 on the phone, the
 *  same Catalog render on wide — and this is the pane itself (2026-09-17). */
const catalogPane = (slug: string): string => paths.appPane(slug, "catalog");

/** The seven rail entries' URLs, in the brief's table order — built from `paths`, never
 *  spelled, so a pane added to `APP_PANES` is walked with no edit here. */
function appRailHrefs(slug: string): string[] {
  return APP_PANES.map((pane) => paths.appPane(slug, pane));
}

/** Those, plus the landing: every URL one app's page answers at. */
function appPaneHrefs(slug: string): string[] {
  return [paths.appDetail(slug), ...appRailHrefs(slug)];
}

type AppSummaryRow = {
  name: string;
  kind: string;
  archived: boolean;
  roles: Record<string, unknown>;
  logBodies: boolean;
  redact: Record<string, string[]>;
  redactResults: Record<string, string[]>;
  status?: string;
  lastSeen?: number | null;
  createdAt?: number;
  endpoint?: string;
  auth?: string;
  forwardIdentity?: boolean;
  connection?: string;
};

let detail: {
  ns: SeededNamespace;
  session: SeededSession;
  /** One owner bearer for every app-detail describe — `user:<name>`, the principal §7
   *  step 2 leaves unfiltered on the scoped endpoint. */
  bearer: string;
};

/**
 * The six apps, five agents, session and bearer every `/apps/<slug>` describe below reads,
 * seeded ONCE and awaited from each of their `beforeAll`s. One world rather than one per
 * describe because §13 makes these panes one page: the rows compare what one pane renders
 * against what another does and against the scoped endpoint's own answer, and two seedings
 * would make those comparisons about two different namespaces.
 *
 * Memoized rather than hung off a single describe's hook, because vitest runs a suite's
 * `beforeAll` only when that suite has an unskipped test — so a `-t` naming any ONE of
 * these describes would otherwise leave `detail` undefined for it.
 */
let appDetailWorld: Promise<void> | null = null;
const withAppDetailWorld = (): Promise<void> => (appDetailWorld ??= seedAppDetailWorld());

async function seedAppDetailWorld(): Promise<void> {
  // §20.2's per-family payloads are registered OUT of the URL: base64-encoding them
  // into a request line trips a real HTTP 431, which is a fact about HTTP rather than
  // about anything under test (fake-upstream's own note).
  await registerOverride(catalogScenario.id, {
    tools: CATALOG_TOOLS,
    prompts: CATALOG_PROMPTS,
    resources: CATALOG_RESOURCES,
    resourceTemplates: CATALOG_TEMPLATES,
  });
  await registerOverride(plainScenario.id, { tools: PLAIN_TOOLS });
  await registerOverride(brokenScenario.id, { tools: CATALOG_TOOLS });

  const ns = await seedNamespace(env.DB, {
    apps: [
      {
        slug: CATALOG,
        kind: "proxy",
        name: "Catalog app",
        upstreamUrl: upstreamUrlFor(catalogScenario),
        upstreamAuthMode: "headers",
        forwardIdentity: true,
        capabilities: ["tools", "prompts", "resources"],
        roles: CATALOG_ROLES,
        redact: { secret_push: ["payload.key"], "digest_.*": ["audience"] },
        redactResults: { "secret_.*": ["out.token"] },
      },
      {
        slug: PLAIN,
        kind: "proxy",
        name: "Plain app",
        upstreamUrl: upstreamUrlFor(plainScenario),
        upstreamAuthMode: "headers",
        roles: {},
      },
      { slug: TUNNELAPP, kind: "tunnel", name: "Tunnel app" },
      { slug: FRESHAPP, kind: "tunnel", name: "Fresh app", logBodies: false },
      {
        slug: BROKEN,
        kind: "proxy",
        name: "Broken app",
        upstreamUrl: upstreamUrlFor(brokenScenario),
        upstreamAuthMode: "oauth",
        capabilities: ["tools", "prompts", "resources"],
      },
      {
        slug: DOWN,
        kind: "proxy",
        name: "Down app",
        upstreamUrl: upstreamUrlFor(downScenario),
        upstreamAuthMode: "headers",
        capabilities: ["tools", "prompts", "resources"],
      },
    ],
    agents: [
      { slug: "reader-agent", grants: { [CATALOG]: [{ role: "reader", mode: "allow" }] } },
      { slug: "crawl-agent", grants: { [CATALOG]: [{ role: "crawler", mode: "approval" }] } },
      {
        slug: "mixed-agent",
        grants: {
          [CATALOG]: [
            { role: "crawler", mode: "approval" },
            { role: "both", mode: "allow" },
          ],
        },
      },
      { slug: "all-agent", grants: { [PLAIN]: [{ role: "all", mode: "allow" }] } },
      {
        slug: "breaker",
        grants: { [BROKEN]: [{ role: "all", mode: "allow" }] },
        tokens: [{ as: "breaker" }],
      },
    ],
  });
  // A tunneled app's roles and its last-connected stamp arrive at registration, so the
  // registration write is what plants them — there is no create field for either.
  await new Registry(env.DB).upsertDeclaredRoles(ns.apps[TUNNELAPP].id, { reader: ["get_.*"] });
  const session = await seedOwnerSession(ns.owner);
  detail = { ns, session, bearer: await deviceFlowToken(session.cookie) };
}

describe(`§2 · /apps/<slug> — the seven panes, the rail, the header and the three levels`, () => {
  beforeAll(withAppDetailWorld);

  // Owner questions 37(b) and 37(a), decided 2026-09-03 (§13 amended): the header's
  // controls land on the app's own page, and a headers-mode app that cannot be reached
  // says so in its own words rather than borrowing the oauth arm's.
  it(`§2 · the app header's Connect refusal and Disconnect land back on the app's own page with the notice — /apps/<slug>/app_disconnect, never /apps/app_disconnect — and a finished Connect lands there too carrying done=connect · /apps's own row controls still land on /apps (the twin)`, async () => {
    await breakBrokensCredential();
    const html = await appPage(paths.appDetail(BROKEN));
    // The header's Disconnect posts to the app page's own dispatch, never the list's.
    expect(formsPostingTo(html, paths.appHeaderDisconnect(BROKEN)).length).toBeGreaterThan(0);
    expect(formsPostingTo(html, paths.appDisconnect(BROKEN))).toEqual([]);
    const csrf = csrfOf(html);

    // A Connect refusal from the header lands on the app page: DOWN is headers-mode, so
    // beginConnect refuses it, which is the cheapest refusal that reaches the redirect.
    const refused = await formPost(paths.appConnect(DOWN), { csrf }, detail.session.cookie);
    expect(refused.status).toBe(303);
    const landing = new URL(refused.headers.get("Location") ?? "", ORIGIN);
    expect(landing.pathname).toBe(paths.appPane(DOWN, "overview"));
    expect(landing.searchParams.get("failed")).toBe("connect");

    // Disconnect from the header: the notice lands on the app page, not on /apps.
    const disconnected = await formPost(paths.appHeaderDisconnect(BROKEN), { csrf }, detail.session.cookie);
    expect(disconnected.status).toBe(303);
    const back = new URL(disconnected.headers.get("Location") ?? "", ORIGIN);
    expect(back.pathname).toBe(paths.appPane(BROKEN, "overview"));
    expect(back.searchParams.get("done")).toBe("app_disconnect");

    // THE TWIN: the list's own rows still post to the list's targets, so the move above is
    // the app page's and not a page-wide rename.
    expect(postTargets(await appPage(paths.apps))).toContain(paths.appConnect(BROKEN));
  });

  it(`§2 · APP_PANES is the six non-landing panes in the brief's table order — catalog, roles, recording, overview, access, token, danger — each answering 200 at its own URL with aria-current="page" on its own rail entry and on no other, while the landing /apps/<slug> renders the Catalog and marks its entry too (2026-09-17) · /apps/<slug>/tools is a 404 and an unknown pane is that same noSuchPage 404 (the twin)`, async () => {
    expect([...APP_PANES]).toEqual([
      "catalog",
      "roles",
      "recording",
      "overview",
      "access",
      "token",
      "danger",
    ]);

    // Seven panes, seven renders: the marked entry is the pane's OWN and no other's.
    for (const href of appRailHrefs(CATALOG)) {
      const current = railEntries(await appPage(href), APP_RAIL_NAV_LABEL).filter((entry) => entry.current);
      expect(current.map((entry) => entry.href), href).toEqual([href]);
    }
    // …and the LANDING marks the Catalog too, because it renders it (2026-09-17).
    const onLanding = railEntries(await appPage(paths.appDetail(CATALOG)), APP_RAIL_NAV_LABEL).filter(
      (entry) => entry.current,
    );
    expect(onLanding.map((entry) => entry.href)).toEqual([catalogPane(CATALOG)]);

    // THE TWIN: an unknown pane is the yardstick, and the two aliases answer exactly it —
    // byte-identical, so "404" is the same refusal rather than three different ones.
    const unknown = await get(`${paths.appDetail(CATALOG)}/${uniqueSlug("nopane")}`, detail.session.cookie);
    expect(unknown.status).toBe(404);
    const yardstick = await unknown.text();
    // `/tools` is the alias that stays a 404; `/catalog` is the pane's own URL and a 200.
    const alias = await get(`${paths.appDetail(CATALOG)}/tools`, detail.session.cookie);
    expect(alias.status).toBe(404);
    expect(await alias.text()).toBe(yardstick);
    expect((await get(catalogPane(CATALOG), detail.session.cookie)).status).toBe(200);
  });

  it(`§2 · GET /apps/<slug>/prompts and GET /apps/<slug>/resources answer 301 to /apps/<slug>/catalog — the Catalog holds them and the query is DROPPED, so ?sel= and ?q= do not ride along — while the six real panes answer 200 at their own URLs and the 301 is permanent, never a 302 or a 303 (the twin)`, async () => {
    for (const moved of ["prompts", "resources"]) {
      // A query on the way in, because "the query is dropped" is the half a bare probe
      // cannot see: a 301 that carried `?sel=` forward would pass without it.
      const from = `${paths.appDetail(CATALOG)}/${moved}?sel=tool:paper_fetch&q=paper`;
      const answered = await get(from, detail.session.cookie);
      expect(answered.status, from).toBe(301);
      expect(answered.headers.get("Location"), from).toBe(catalogPane(CATALOG));
    }
    // THE TWIN: the panes that still exist are 200s at their own URLs, so the 301 is a
    // statement about two names and not about the pane route.
    for (const href of appPaneHrefs(CATALOG)) {
      expect((await get(href, detail.session.cookie)).status, href).toBe(200);
    }
  });

  it(`§2 · the app rail carries exactly the seven entries of the brief's pane table, in its order and under its headings — App holding Catalog, Roles, Recording and Overview, Access holding Agents and Token, and Danger zone ungrouped after them — and no pane renders a pill row: no nav.pill-row and no "App panes, compact" navigation on any of the seven, while /settings still renders its (the twin)`, async () => {
    const html = await appPage(paths.appDetail(CATALOG));
    const rail = railEntries(html, APP_RAIL_NAV_LABEL);
    // The hrefs come from `paths`, never spelled; the labels are the table's own words.
    expect(rail.map((entry) => entry.href)).toEqual(appRailHrefs(CATALOG));
    expect(rail.map((entry) => entry.label)).toEqual([
      "Catalog",
      "Roles",
      "Recording",
      "Overview",
      "Agents",
      "Token",
      "Danger zone",
    ]);

    // The two headings, read as ORDER inside the rail's own block rather than as markup.
    const railText = textOf(navBlock(html, APP_RAIL_NAV_LABEL) ?? "");
    const at = (word: string): number => {
      const found = railText.indexOf(word);
      expect(found, `the rail does not read "${word}"`).toBeGreaterThanOrEqual(0);
      return found;
    };
    expect(at("App")).toBeLessThan(at("Catalog"));
    expect(at("Overview")).toBeLessThan(at("Access"));
    expect(at("Access")).toBeLessThan(at("Agents"));
    expect(at("Token")).toBeLessThan(at("Danger zone"));

    // No pill row on ANY of the seven — the rail-as-list is its replacement (2026-09-16).
    for (const href of appPaneHrefs(CATALOG)) {
      const pane = await appPage(href);
      expect(railEntries(pane, APP_PILL_NAV_LABEL), href).toEqual([]);
      expect(pane, href).not.toContain('class="pill-row"');
    }
    // THE TWIN: /settings still draws its, so "no pill row" is this page's property.
    expect(railEntries(await page(paths.settings), PILL_NAV_LABEL).length).toBeGreaterThan(0);
  });

  it(`§2 · the Catalog rail marker is the app's tools + prompts + resources summed, BLANK when a family could not be read and the dimmed — when the app never connected; the Roles marker is the effective role count or "none"; the Agents marker is the number of agents holding ≥1 grant; the Token marker is the live count and the dimmed — for a proxied app; Overview and Danger zone carry no marker at all (the twin)`, async () => {
    const html = await appPage(paths.appDetail(CATALOG));
    const summed =
      CATALOG_TOOLS.length + CATALOG_PROMPTS.length + CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length;
    expect(markerOn(html, catalogPane(CATALOG))).toBe(String(summed));
    // The effective map, not the declaration: a proxied app's roles are all the owner's.
    expect(markerOn(html, paths.appPane(CATALOG, "roles"))).toBe(String(Object.keys(CATALOG_ROLES).length));
    const holders = (await grantsOnCatalog()) as Record<string, GrantEntry[]>;
    expect(markerOn(html, paths.appPane(CATALOG, "access"))).toBe(String(Object.keys(holders).length));
    // Proxied: no token dials in, so the marker is the dimmed em dash and never 0.
    expect(markerOn(html, paths.appPane(CATALOG, "token"))).toBe(DIMMED_MARKER);
    for (const pane of ["overview", "danger"] as const) {
      expect(markerOn(html, paths.appPane(CATALOG, pane)), pane).toBe("");
    }

    // BLANK, not — and not 0: the app whose live listing could not be read at all.
    expect(markerOn(await appPage(catalogPane(DOWN)), catalogPane(DOWN))).toBe("");
    // The dimmed —: the tunneled app that has never connected, so there is no catalog.
    const fresh = await appPage(catalogPane(FRESHAPP));
    expect(markerOn(fresh, catalogPane(FRESHAPP))).toBe(DIMMED_MARKER);
    // THE TWIN on the same render: an app with no role of any kind reads `none`.
    expect(markerOn(await appPage(paths.appDetail(PLAIN)), paths.appPane(PLAIN, "roles"))).toBe("none");
  });

  it(`§2 · the Recording rail marker is the Two-factor dot's own markup and never a number — rail-dot--on with the sr-only text "on" while body logging is on, rail-dot--off with "off" when it is off — read on one app either side of a saved switch (the twin)`, async () => {
    // Its own app, because the switch below is a WRITE and the shared world is read by
    // four describes.
    const slug = uniqueSlug("dot");
    const ns = await seedNamespace(env.DB, { apps: [{ slug, kind: "tunnel", logBodies: true }] });
    const { cookie } = await seedOwnerSession(ns.owner);
    const pane = paths.appPane(slug, "recording");

    const on = await page(pane, cookie);
    const onAnchor = appRailAnchor(on, slug, pane);
    expect(onAnchor).toContain("rail-dot--on");
    expect(onAnchor).not.toContain("rail-dot--off");
    expect(textOf(onAnchor)).toContain("on");
    expect(markerOn(on, pane), "a dot is not a count").not.toMatch(/\d/);

    // THE TWIN: the same app after the switch is saved off, through the pane's own form.
    const posted = await formPost(
      actionFor(on, "recording_set"),
      unticked(paneSubmission(on, actionFor(on, "recording_set"))),
      cookie,
    );
    expect(posted.status).toBe(303);
    const off = await page(pane, cookie);
    const offAnchor = appRailAnchor(off, slug, pane);
    expect(offAnchor).toContain("rail-dot--off");
    expect(offAnchor).not.toContain("rail-dot--on");
    expect(textOf(offAnchor)).toContain("off");
  });

  it(`§2 · the header's title row is the "Apps ›" crumb linking /apps, the app's name, then its slug, kind and status as badge--title, with the description as the subtitle — and ONE tiles line beneath reading "T tools · P prompts · R resources · A agents · body logging on|off", a tunneled app adding " · last seen <relative>" and no pane carrying a separate "Last seen" note anywhere (the twin: the proxied app's tiles carry no last seen)`, async () => {
    const html = await appPage(paths.appDetail(CATALOG));
    const row = await appRowOf(CATALOG);
    const text = textOf(html);
    // The crumb is IN the title row, and it is a link to the list.
    expect(text).toContain(`Apps › ${row.name}`);
    expect(links(html, paths.apps)).toBe(true);
    // slug / kind / status as title badges, read off the class the brief names.
    const titleBadges = [...html.matchAll(/class="[^"]*badge--title[^"]*"[^>]*>([^<]*)</g)].map((badge) =>
      textOf(badge[1]),
    );
    expect(titleBadges).toContain(CATALOG);
    expect(titleBadges).toContain(row.kind);
    // A status badge only where §8's row HAS a status — a proxied app carries none.
    if (row.status !== undefined) expect(titleBadges).toContain(row.status);

    // ONE tiles line, its numbers the same ones the rail sums.
    const agents = Object.keys(await grantsOnCatalog()).length;
    expect(text).toContain(
      `${CATALOG_TOOLS.length} tools · ${CATALOG_PROMPTS.length} prompts · ` +
        `${CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length} resources · ${agents} agents · body logging off`,
    );
    // THE TWIN, and the "no separate note" half: a proxied app has no last seen at all.
    expect(text).not.toContain("last seen");
    expect(text).not.toContain("Last seen");

    // A tunneled app carries the tail, and still no note of its own anywhere.
    const tunneled = uniqueSlug("tiles");
    const close = await dialTunnel(tunneled, { capabilities: ["tools"], tools: PLAIN_TOOLS });
    try {
      const tunnelText = textOf(await appPage(paths.appDetail(tunneled)));
      expect(tunnelText).toContain("· last seen ");
      expect(tunnelText).not.toContain("Last seen");
    } finally {
      await close();
    }
  });

  it(`§2 · the proxied header card — endpoint, auth mode, forward identity and the Connect / Disconnect controls — sits above the pane on every pane EXCEPT Overview, which absorbs those fields into its own listing · a tunneled app renders no header card on any pane (the twin)`, async () => {
    const row = await appRowOf(CATALOG);
    if (row.endpoint === undefined) throw new Error("the proxied fixture carries no endpoint");
    for (const href of appPaneHrefs(CATALOG)) {
      const text = textOf(await appPage(href));
      // Overview draws the same fields as its OWN listing, so the card's absence there is
      // asserted structurally — by the class the card carries — and not by the endpoint.
      expect(text, href).toContain(row.endpoint);
    }
    // ABOVE THE PANE, read as position rather than as a class: the card is whatever sits
    // before the rail, and Overview's copy of the same three fields is inside its listing.
    const aboveRail = (html: string): string => textOf(html.slice(0, html.indexOf('aria-label="App panes"')));
    expect(aboveRail(await appPage(paths.appPane(CATALOG, "overview")))).not.toContain("Forward identity");
    for (const href of appPaneHrefs(CATALOG).filter((pane) => pane !== paths.appPane(CATALOG, "overview"))) {
      expect(aboveRail(await appPage(href)), href).toContain("Forward identity");
    }

    // The controls, on the oauth app that has them, on every pane but Overview.
    await breakBrokensCredential();
    for (const href of appPaneHrefs(BROKEN)) {
      const drawn = postTargets(await appPage(href));
      const expected = href !== paths.appPane(BROKEN, "overview");
      expect(drawn.includes(paths.appHeaderDisconnect(BROKEN)), href).toBe(expected);
    }

    // THE TWIN: a tunneled app draws no card on any pane.
    for (const href of appPaneHrefs(TUNNELAPP)) {
      expect(await appPage(href), href).not.toContain('class="app-card"');
    }
  });

  it(`§2 · the app page's root carries data-level chosen from the URL alone — 1 on /apps/<slug>, 2 on each of the seven panes, 3 on a pane carrying sel= — and the level header above the content names the level above and the current thing: at 1 "‹ Apps" → /apps titled with the app's name, at 2 "‹ <name>" → /apps/<slug> titled with the pane's own rail label, at 3 "‹ <pane label>" → the pane URL WITHOUT sel but keeping q, new and which, titled with the selected row's name`, async () => {
    const name = (await appRowOf(CATALOG)).name;
    const landingHref = paths.appDetail(CATALOG);
    const landing = await appPage(landingHref);
    expect(levelOf(landing)).toBe("1");
    expect(levelHeader(landing)).toEqual({ back: "‹ Apps", href: paths.apps, title: name });

    // Level 2 — one per pane, titled with the pane's OWN rail label, read off the rail.
    const labels = new Map(
      railEntries(landing, APP_RAIL_NAV_LABEL).map((entry) => [entry.href, entry.label] as const),
    );
    for (const href of appRailHrefs(CATALOG)) {
      const html = await appPage(href);
      expect(levelOf(html), href).toBe("2");
      expect(levelHeader(html), href).toEqual({
        back: `‹ ${name}`,
        href: landingHref,
        title: labels.get(href) ?? "",
      });
    }

    // Level 3 — a pane carrying `sel`, whose back link drops `sel` and keeps `q`.
    const selected = `${paths.appPane(CATALOG, "roles")}?q=paper&sel=role:reader`;
    // …and the Catalog reaches it at its own URL, never at the landing's (2026-09-17).
    expect(levelOf(await appPage(`${catalogPane(CATALOG)}?sel=tool:paper_fetch`))).toBe("3");
    expect(levelHeader(await appPage(`${catalogPane(CATALOG)}?sel=tool:paper_fetch`)).href).toBe(
      catalogPane(CATALOG),
    );
    const details = await appPage(selected);
    expect(levelOf(details)).toBe("3");
    expect(levelHeader(details)).toEqual({
      back: `‹ ${labels.get(paths.appPane(CATALOG, "roles")) ?? ""}`,
      href: `${paths.appPane(CATALOG, "roles")}?q=paper`,
      title: "reader",
    });
  });

  it(`§2 · the three wide panes render the listing alone — Overview, Danger zone, and Token for a PROXIED app carry listing--wide, no details pane and no level 3, so a sel= on them is still data-level 2 · a tunneled app's Token pane and the four other panes render listing + details and reach level 3 (the twin)`, async () => {
    const wide = [
      paths.appPane(CATALOG, "overview"),
      paths.appPane(CATALOG, "danger"),
      paths.appPane(CATALOG, "token"),
    ];
    for (const href of wide) {
      const html = await appPage(href);
      expect(html, href).toContain("listing--wide");
      // A `sel` cannot take a wide pane to level 3: there is nothing to select into.
      expect(levelOf(await appPage(`${href}?sel=role:reader`)), href).toBe("2");
    }
    // THE TWIN: every other pane is listing + details, and a `sel` reaches level 3.
    for (const href of appPaneHrefs(CATALOG).filter((pane) => !wide.includes(pane))) {
      expect(await appPage(href), href).not.toContain("listing--wide");
    }
    // …and a TUNNELED app's Token pane is one of them, because it has tokens to list.
    const tunneled = await appPage(paths.appPane(TUNNELAPP, "token"));
    expect(tunneled).not.toContain("listing--wide");
  });
});

describe(`§3 · /apps/<slug> — the Catalog pane`, () => {
  beforeAll(withAppDetailWorld);

  it(`§3 · the Catalog listing header is the title Catalog over its kind's subtitle — tunneled "advertised by the app on its last connect · re-listed on every reconnect", proxied "fetched live from the upstream" — the summary line "T tools · P prompts · R resources · reachable by N agent(s)", and the filter as a GET form named q with the placeholder "filter tools, prompts, resources…" (the twin: the two kinds side by side)`, async () => {
    const html = await appPage(catalogPane(CATALOG));
    const text = textOf(html);
    expect(text).toContain("Catalog");
    expect(text).toContain(CATALOG_PROXIED_SUB);
    expect(text).not.toContain(CATALOG_TUNNELED_SUB);
    const agents = Object.keys(await grantsOnCatalog()).length;
    expect(text).toContain(
      `${CATALOG_TOOLS.length} tools · ${CATALOG_PROMPTS.length} prompts · ` +
        `${CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length} resources · reachable by ${agents} agents`,
    );
    // The filter is a GET form, so it survives scripting off and lands back on this pane.
    expect(html).toContain('placeholder="filter tools, prompts, resources…"');
    const filter = getFormsOn(html).find((form) => form.fields.includes("q"));
    expect(filter?.action, "the filter lands back on the pane it filters").toBe(catalogPane(CATALOG));

    // THE TWIN: the tunneled kind, same pane, its own sentence and not the other's.
    const tunneled = uniqueSlug("cathead");
    const close = await dialTunnel(tunneled, { capabilities: ["tools"], tools: PLAIN_TOOLS });
    try {
      const tunnelText = textOf(await appPage(catalogPane(tunneled)));
      expect(tunnelText).toContain(CATALOG_TUNNELED_SUB);
      expect(tunnelText).not.toContain(CATALOG_PROXIED_SUB);
    } finally {
      await close();
    }
  });

  it(`§3 · the three groups "Tools · N", "Prompts · N" and "Resources · N" list the whole catalog in ONE pane — resources and templates in the Resources group, a template listed by its raw uriTemplate — and every row IS its own ?sel= link: sel=tool:<name>, sel=prompt:<name>, sel=resource:<uri>, the URI encoded and never the name (the twin: a resource whose NAME matches another row's URI is still selected by its own URI)`, async () => {
    const landing = catalogPane(CATALOG);
    const html = await appPage(landing);
    const text = textOf(html);
    expect(text).toContain(`Tools · ${CATALOG_TOOLS.length}`);
    expect(text).toContain(`Prompts · ${CATALOG_PROMPTS.length}`);
    expect(text).toContain(`Resources · ${CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length}`);
    // A template is listed by its RAW uriTemplate — §20.3 makes it an ordinary subject
    // string rather than something the hub expands.
    for (const template of CATALOG_TEMPLATE_URIS) expect(text, template).toContain(template);

    // Every row IS the link, read as the `sel` values the pane's own anchors carry.
    expect(selValuesOn(html, landing).sort()).toEqual(
      [
        ...CATALOG_TOOL_NAMES.map((name) => `tool:${name}`),
        ...CATALOG_PROMPT_NAMES.map((name) => `prompt:${name}`),
        ...[...CATALOG_RESOURCE_URIS, ...CATALOG_TEMPLATE_URIS].map((uri) => `resource:${uri}`),
      ].sort(),
    );
    // THE TWIN (§20.2's trap): the decoy row's NAME is another row's URI, and it is still
    // selected by its own URI — a `sel` naming the decoy's name reaches nothing.
    expect(selValuesOn(html, landing)).toContain(`resource:${CATALOG_RESOURCES[1].uri}`);
    expect(selValuesOn(html, landing)).not.toContain(`resource:${CATALOG_RESOURCES[1].name}`);
  });

  it(`§3 · a group of an unadvertised family reads "none advertised" beside its heading over ONE note row — tunneled "This app declared no <family> capability on its last connect." / proxied "The capabilities configured for this app omit <family>." with the family substituted — while the families the same app does advertise carry counts and list rows (the twin)`, async () => {
    // Proxied: §20.2's "absent ≡ [tools]", so prompts and resources are unadvertised.
    const plain = textOf(await appPage(catalogPane(PLAIN)));
    for (const family of ["prompts", "resources"]) {
      expect(plain, family).toContain(pinned(proxiedOmits(family)));
    }
    expect(plain).toContain(NONE_ADVERTISED);
    // THE TWIN on the same render: the family it DOES advertise lists its row.
    expect(plain).toContain(PLAIN_TOOLS[0].name);
    expect(plain).toContain(`Tools · ${PLAIN_TOOLS.length}`);

    // Tunneled: the same shape, its own sentence.
    const slug = uniqueSlug("declares");
    const served = [{ name: uniqueSlug("brief").replace(/-/g, "_"), description: "One." }];
    const close = await dialTunnel(slug, { capabilities: ["tools", "prompts"], prompts: served, tools: PLAIN_TOOLS });
    try {
      const text = textOf(await appPage(catalogPane(slug)));
      expect(text).toContain(tunneledUndeclared("resources"));
      expect(text).not.toContain(pinned(proxiedOmits("resources")));
      expect(text).toContain(served[0].name);
    } finally {
      await close();
    }
  });

  it(`§3 · a tunneled app that has never connected renders ONE note — "This app has never connected, so the hub has no catalog to list yet." — in place of all three groups, and its Catalog rail marker is the dimmed — · the tunneled app beside it that connected lists its groups under a numeric marker (the twin)`, async () => {
    const html = await appPage(catalogPane(FRESHAPP));
    const text = textOf(html);
    expect(text).toContain(NEVER_CONNECTED);
    expect(markerOn(html, catalogPane(FRESHAPP))).toBe(DIMMED_MARKER);
    // In place of ALL THREE: the note is the whole listing, not a fourth line beside them.
    expect(text).not.toContain(NONE_ADVERTISED);
    for (const family of ["tools", "prompts", "resources"]) {
      expect(text, family).not.toContain(tunneledUndeclared(family));
    }

    // THE TWIN: a tunneled app that HAS connected lists and counts.
    const slug = uniqueSlug("connected");
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools: PLAIN_TOOLS });
    try {
      const connected = await appPage(catalogPane(slug));
      expect(textOf(connected)).not.toContain(NEVER_CONNECTED);
      expect(markerOn(connected, catalogPane(slug))).toBe(String(PLAIN_TOOLS.length));
    } finally {
      await close();
    }
  });

  it(`§3 · a proxied app whose live listing failed renders the unread state, never an empty one: "Couldn't reach <endpoint> — the live listing failed, so nothing is shown; calls return errors until it answers again." naming its own configured endpoint, or "Token refresh failed — calls return errors until you reconnect." beside Reconnect where the refresh is what broke — with a BLANK Catalog marker, never — and never 0 · the reachable proxied app beside it lists rows (the twin)`, async () => {
    // The endpoint is read off §8's own row, never off the fixture's scenario.
    const endpoint = (await appRowOf(DOWN)).endpoint ?? "";
    expect(endpoint).not.toBe("");
    const down = await appPage(catalogPane(DOWN));
    expect(textOf(down)).toContain(unreachable(endpoint));
    expect(markerOn(down, catalogPane(DOWN))).toBe("");
    // A headers-mode app cannot reconnect, so it offers no control to do it with.
    expect(postTargets(down)).not.toContain(paths.appConnect(DOWN));

    // The other arm: the oauth app whose refresh failed says so, beside Reconnect.
    await breakBrokensCredential();
    const broken = await appPage(catalogPane(BROKEN));
    expect(textOf(broken)).toContain(REFRESH_FAILED);
    expect(postTargets(broken)).toContain(paths.appConnect(BROKEN));
    expect(markerOn(broken, catalogPane(BROKEN))).toBe("");

    // THE TWIN: the reachable proxied app's marker is a number and its rows are listed.
    const reachable = await appPage(catalogPane(CATALOG));
    expect(markerOn(reachable, catalogPane(CATALOG))).toMatch(/^\d+$/);
    expect(textOf(reachable)).toContain(CATALOG_TOOL_NAMES[0]);
  });

  it(`§3 · a Catalog row is the name in mono over its description as one inline line, with one badge per agent that reaches it — "<agent>" where the grant allows and "<agent> · ask" as badge--warning where it asks — or the dim "no agent" where none does; an agent holding no grant on this app is named on no row, and an agent holding an allow role and an ask role over the same item is badged once, allow (the twin)`, async () => {
    const text = textOf(await appPage(catalogPane(CATALOG)));
    const blocks = blocksOf(text, CATALOG_TOOL_NAMES);

    // `reader` reaches paper_fetch in allow mode and nothing else does.
    expect(blocks.paper_fetch).toContain("reader-agent");
    expect(blocks.paper_fetch).not.toContain("reader-agent · ask");

    // jobfeed_crawl: `crawl-agent` asks, and `mixed-agent` holds BOTH an asking role and
    // an allowing one over the same tool — allow wins, so it is badged once, plainly.
    expect(blocks.jobfeed_crawl).toContain("crawl-agent · ask");
    expect(blocks.jobfeed_crawl).toContain("mixed-agent");
    expect(blocks.jobfeed_crawl).not.toContain("mixed-agent · ask");

    // A tool no granted pattern reaches reads the dim "no agent".
    expect(blocks.secret_push).toContain(NO_AGENT);

    // An agent with no grant on THIS app is named on no row at all.
    expect(text).not.toContain("all-agent");
  });

  it(`§3 · q filters every group by name or description substring and a group nothing matches reads "no match" under its own heading while the groups that do match still list rows · the unfiltered pane lists every row (the twin)`, async () => {
    const landing = catalogPane(CATALOG);
    // A term that reaches ONE tool by name and no prompt or resource at all.
    const byName = textOf(await appPage(`${landing}?q=jobfeed`));
    expect(byName).toContain("jobfeed_crawl");
    expect(byName).not.toContain("paper_fetch");
    expect(byName).toContain(NO_MATCH);

    // …and by DESCRIPTION, which is the half a name-only filter would pass without.
    const byDescription = textOf(await appPage(`${landing}?q=DOI`));
    expect(byDescription).toContain("paper_fetch");
    expect(byDescription).not.toContain("jobfeed_crawl");

    // THE TWIN: unfiltered, every row is there and nothing reads "no match".
    const all = textOf(await appPage(landing));
    for (const name of CATALOG_TOOL_NAMES) expect(all, name).toContain(name);
    expect(all).not.toContain(NO_MATCH);
  });

  it(`§3 · the Catalog details with nothing selected is the title Catalog over "Select a tool, prompt or resource for its details." and the card "Where this comes from": Schemas → tunneled "the app's last tools/list — the hub stores them, it does not author them" / proxied "the upstream's live listing, under a 10 s deadline", Reach → "computed with the gate's own matcher over each agent's grant"`, async () => {
    const text = textOf(await appPage(catalogPane(CATALOG)));
    expect(text).toContain(CATALOG_PROMPT);
    expect(text).toContain("Where this comes from");
    expect(text).toContain(pinned("the upstream's live listing, under a 10 s deadline"));
    expect(text).toContain(REACH_SOURCE);

    // The tunneled arm of the same card.
    const slug = uniqueSlug("catwhere");
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools: PLAIN_TOOLS });
    try {
      const tunneled = textOf(await appPage(catalogPane(slug)));
      expect(tunneled).toContain(
        pinned("the app's last `tools/list` — the hub stores them, it does not author them"),
      );
      expect(tunneled).not.toContain(pinned("the upstream's live listing, under a 10 s deadline"));
    } finally {
      await close();
    }
  });

  it(`§3 · a selected tool draws its name, a "tool" family badge and the full description as Markdown over the Arguments card: one row per schema LEAF — dotted paths, objects recursed into, an array printed as <type>[] and not recursed, required read off each level's own list — with a "writeOnly · masked" warning badge where the leaf declares it and "none" where the schema declares nothing, and a "Result · outputSchema" card of the same rows only where the tool declares one (the twin: the tool next door that declares none draws no Result card)`, async () => {
    const landing = catalogPane(CATALOG);
    const selected = textOf(await appPage(`${landing}?sel=tool:paper_fetch`));
    expect(selected).toContain("paper_fetch");
    expect(selected).toContain("tool");
    // The whole description, not the row's first line.
    expect(selected).toContain(PAPER_DETAIL);
    expect(selected).toContain("Arguments");
    // The LEAVES, derived on both sides — `schemaLeaves` is the page's own reader.
    const leaves = schemaLeaves(PAPER_SCHEMA);
    expect(leaves.map((leaf) => leaf.path)).toContain("options.depth");
    for (const leaf of leaves) expect(selected, leaf.path).toContain(leaf.path);

    // A schema declaring nothing reads `none` rather than an empty card.
    expect(textOf(await appPage(`${landing}?sel=tool:jobfeed_crawl`))).toContain("none");

    // The writeOnly badge, where the app declared one.
    const secret = textOf(await appPage(`${landing}?sel=tool:secret_push`));
    expect(secret).toContain("credentials.token");
    expect(secret).toContain("writeOnly · masked");
    // THE TWIN: neither tool declares an output schema, so neither draws the Result card.
    expect(secret).not.toContain("Result · outputSchema");

    // …and one that does, on a tunneled app of this row's own.
    const slug = uniqueSlug("outschema");
    const outputSchema = { type: "object", properties: { rows: { type: "array", items: { type: "string" } } } };
    const tool = { name: "with_output", description: "Answers.", inputSchema: { type: "object" }, outputSchema };
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools: [tool] });
    try {
      const withOutput = textOf(await appPage(`${catalogPane(slug)}?sel=tool:with_output`));
      expect(withOutput).toContain("Result · outputSchema");
      // An array is printed as `<type>[]` and is not recursed into.
      expect(withOutput).toContain("string[]");
    } finally {
      await close();
    }
  });

  it(`§3/§20.3 · a selected PROMPT's Arguments card is one row per DECLARED argument and never a schema leaf — the argument's name as the path, its description or — in the type column, required / optional read off the declaration and no writeOnly badge anywhere — and it draws no Result card and no Resource card · a selected resource draws the Resource card instead — URI, Type, "Served on" → "the scoped endpoint only — <origin>/<user>/mcp/<slug>" printed with the hub's own origin and the owner's username, copyable and with the placeholder nowhere on the page, and "Matched" → "by URI, never by name" — and no Arguments card (the twin)`, async () => {
    const landing = catalogPane(CATALOG);
    const prompt = await appPage(`${landing}?sel=prompt:digest_daily`);
    const promptText = textOf(prompt);
    const declared = CATALOG_PROMPTS[0].arguments[0];
    expect(promptText).toContain("Arguments");
    expect(promptText).toContain(declared.name);
    expect(promptText).toContain(declared.description);
    expect(promptText).toContain("required");
    expect(promptText).not.toContain("writeOnly");
    expect(promptText).not.toContain("Result · outputSchema");
    expect(promptText).not.toContain("Served on");
    // The prompt with no argument reads the empty word rather than an empty card.
    expect(textOf(await appPage(`${landing}?sel=prompt:weekly_note`))).toContain("none");

    // THE TWIN: a resource draws the Resource card and no Arguments card.
    const resourceHref = `${landing}?sel=resource:${encodeURIComponent(CATALOG_RESOURCE_URIS[0])}`;
    const resource = await appPage(resourceHref);
    const resourceText = textOf(resource);
    const scoped = `${ORIGIN}${paths.mcpScoped(detail.ns.owner.username, CATALOG)}`;
    expect(resourceText).toContain(CATALOG_RESOURCE_URIS[0]);
    expect(resourceText).toContain(CATALOG_RESOURCES[0].mimeType);
    expect(resourceText).toContain(`the scoped endpoint only — ${scoped}`);
    expect(resource, "the placeholder is nowhere on the page").not.toContain("<hub>");
    expect(resource).not.toContain("<user>");
    expect(resourceText).toContain(MATCHED_BY_URI);
    expect(resourceText).not.toContain("Arguments");
  });

  it(`§3 · the "What only the hub knows" card: "Called as <slug>_<name> on the aggregated endpoint" on a tool and a prompt and on NO resource; "Reachable by" as one line per agent "<agent> · via <entries>" or "no agent yet"; "Approval" reading "asked for <agents>" / "none required" on a tool and "never asked for prompts" on a prompt and absent on a resource; "Redaction" reading "arguments <paths> · results <paths>" over the config entries plus the writeOnly leaves, or "no redacted fields", and absent on a resource (the twin)`, async () => {
    const landing = catalogPane(CATALOG);

    // A tool every reaching agent reaches in allow mode.
    const paper = textOf(await appPage(`${landing}?sel=tool:paper_fetch`));
    expect(paper).toContain(`${CATALOG}_paper_fetch on the aggregated endpoint`);
    expect(paper).toContain("reader-agent · via reader");
    expect(paper).toContain(NO_APPROVAL);
    expect(paper).toContain(NO_REDACTED);

    // A tool one agent reaches only in approval mode.
    const jobfeed = textOf(await appPage(`${landing}?sel=tool:jobfeed_crawl`));
    expect(jobfeed).toContain("asked for");
    expect(jobfeed).toContain("crawl-agent");

    // A tool no granted pattern reaches, whose redaction is config plus writeOnly.
    const secret = textOf(await appPage(`${landing}?sel=tool:secret_push`));
    expect(secret).toContain(NO_AGENT_YET);
    expect(secret).toContain("arguments");
    expect(secret).toContain("payload.key");
    expect(secret).toContain("credentials.token");
    expect(secret).toContain("results");
    expect(secret).toContain("out.token");

    // A prompt: the aggregated name, and the fixed approval sentence.
    const prompt = textOf(await appPage(`${landing}?sel=prompt:digest_daily`));
    expect(prompt).toContain(`${CATALOG}_digest_daily on the aggregated endpoint`);
    expect(prompt).toContain(NEVER_GATED);
    expect(prompt).toContain("audience");

    // THE TWIN: a resource has neither an aggregated name, nor Approval, nor Redaction.
    const resource = textOf(
      detailsPaneOf(await appPage(`${landing}?sel=resource:${encodeURIComponent(CATALOG_RESOURCE_URIS[0])}`)),
    );
    expect(mentions(resource, `${CATALOG}_`)).toBe(0);
    // The DETAILS pane's own text: "Approvals" is the shell's nav link on every page.
    const hubCard = resource.slice(resource.indexOf("What only the hub knows"));
    expect(hubCard).not.toContain("Approval");
    expect(hubCard).not.toContain("Redaction");
    expect(hubCard).toContain("Reachable by");
  });

  it(`§3 · the Catalog details foot reads "The same block the audit row and the agent page show for this <family>. Editing reach happens on Agents, masking on Recording." with the family substituted and both words linking their own panes — /apps/<slug>/access and /apps/<slug>/recording`, async () => {
    const landing = catalogPane(CATALOG);
    for (const [sel, family] of [
      ["tool:paper_fetch", "tool"],
      ["prompt:digest_daily", "prompt"],
      [`resource:${encodeURIComponent(CATALOG_RESOURCE_URIS[0])}`, "resource"],
    ] as const) {
      const html = await appPage(`${landing}?sel=${sel}`);
      expect(textOf(html), sel).toContain(catalogFoot(family));
      expect(links(html, paths.appPane(CATALOG, "access")), sel).toBe(true);
      expect(links(html, paths.appPane(CATALOG, "recording")), sel).toBe(true);
    }
  });

  it(`§3/§7 · the Catalog is the owner's own unfiltered read AND the scoped endpoint's own listing: a tool no granted pattern reaches is listed beside the ones that are (§7 step 2 — owner → all), and tools/list, prompts/list, resources/list and resources/templates/list posted to /<user>/mcp/<slug> under the owner's own bearer answer exactly the names the pane rendered and exactly the numbers its rail marker sums — for a tunneled app and for a proxied one`, async () => {
    const tunneled = uniqueSlug("scoped");
    const close = await dialTunnel(tunneled, {
      capabilities: ["tools", "prompts", "resources"],
      tools: PLAIN_TOOLS,
      prompts: [{ name: "one_prompt", description: "One." }],
      resources: [{ uri: "news://one", name: "One", mimeType: "text/plain" }],
    });
    try {
      for (const slug of [CATALOG, tunneled]) {
        const html = await appPage(catalogPane(slug));
        const text = textOf(html);
        const listed = [
          ...((await scopedList(slug, "tools/list")).tools ?? []).map((row) => row.name),
          ...((await scopedList(slug, "prompts/list")).prompts ?? []).map((row) => row.name),
          ...((await scopedList(slug, "resources/list")).resources ?? []).map((row) => row.uri ?? ""),
          ...((await scopedList(slug, "resources/templates/list")).resourceTemplates ?? []).map(
            (row) => row.uriTemplate ?? "",
          ),
        ];
        expect(listed.length, slug).toBeGreaterThan(0);
        for (const name of listed) expect(text, `${slug} · ${name}`).toContain(name);
        expect(markerOn(html, catalogPane(slug)), slug).toBe(String(listed.length));
      }
    } finally {
      await close();
    }
    // §7 step 2, on the app whose grants reach only some of it: the tool no granted
    // pattern reaches is listed all the same, which is what "the owner's own unfiltered
    // read" means — and its row says so rather than hiding it.
    const unreached = textOf(rowMarkupFor(await appPage(catalogPane(CATALOG)), "tool:secret_push"));
    expect(unreached).toContain("secret_push");
    expect(unreached).toContain(NO_AGENT);
  });

  it(`§3 · a tunneled app's Catalog is the DO's cached catalog: the tools it advertised on its last connect are listed and counted while its socket is open, and are still listed, unchanged and still counted, after the socket closes and the header reads offline`, async () => {
    const slug = uniqueSlug("cached");
    const tools = [
      { name: uniqueSlug("kept").replace(/-/g, "_"), description: "One.", inputSchema: { type: "object" } },
      { name: uniqueSlug("held").replace(/-/g, "_"), description: "Two.", inputSchema: { type: "object" } },
    ];
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools });
    const landing = catalogPane(slug);
    const online = await appPage(landing);
    for (const tool of tools) expect(textOf(online), tool.name).toContain(tool.name);
    expect(markerOn(online, landing)).toBe(String(tools.length));
    expect(textOf(online)).toMatch(/\bonline\b/);

    await close();
    const offline = await appPage(landing);
    for (const tool of tools) expect(textOf(offline), tool.name).toContain(tool.name);
    expect(markerOn(offline, landing)).toBe(String(tools.length));
    expect(textOf(offline)).toMatch(/\boffline\b/);
  });

  it(`§3 · a description is the Markdown an app wrote it in (2026-09-16): the row renders its FIRST paragraph inline with every block wrapper dropped so the row stays one line, the details render it whole — **bold** as <strong>, a fence as <pre><code>, a list as <ul>, an http link carrying rel="noopener noreferrer" target="_blank" — while the app's own markup never becomes markup: a javascript: link renders as its own text with no anchor and a literal <script> arrives escaped (the twin)`, async () => {
    const landing = catalogPane(CATALOG);
    const details = await appPage(`${landing}?sel=tool:${MARKDOWN_TOOL.name}`);
    expect(details).toContain("<strong>");
    expect(details).toContain("<pre><code");
    expect(details).toContain("<ul>");
    expect(details).toMatch(/rel="noopener noreferrer"/);
    expect(details).toMatch(/target="_blank"/);
    // THE TWIN, the app's markup as data: no javascript: anchor and no live <script>.
    expect(details).not.toContain('href="javascript:');
    expect(details).not.toContain("<script>alert");
    expect(details).toContain("&lt;script&gt;");

    // The ROW is the first paragraph inline, with the block wrappers dropped.
    const row = rowMarkupFor(await appPage(landing), `tool:${MARKDOWN_TOOL.name}`);
    expect(row).not.toContain("<pre");
    expect(row).not.toContain("<ul>");
  });

  it(`§3 · the Catalog pane edits nothing: on either kind of app it renders no mutating form of any kind, no checkbox and no radio · the same page's header card, Roles, Recording and Agents panes do (the twin)`, async () => {
    for (const slug of [CATALOG, TUNNELAPP]) {
      const html = await appPage(catalogPane(slug));
      // The header's own controls are a proxied-oauth thing and neither fixture has them,
      // so the pane's own emptiness is the whole claim here.
      expect(opsOn(html), slug).toEqual([]);
      expect(html, slug).not.toContain('type="checkbox"');
      expect(html, slug).not.toContain('type="radio"');
    }
    // THE TWIN: the three panes that DO edit, on the same app.
    // The three composed Save targets — op-SHAPED without being ops (§4/§5 compose one
    // app_update each), which is what the parity row's own exemption records.
    expect(opsOn(await appPage(`${paths.appPane(CATALOG, "roles")}?sel=role:reader`))).toContain("role_set");
    expect(opsOn(await appPage(paths.appPane(CATALOG, "recording")))).toContain("recording_set");
    expect(opsOn(await appPage(`${paths.appPane(CATALOG, "access")}?sel=agent:reader-agent`))).toContain(
      "grant_set",
    );
  });
});

/* ------------------------------------------------------------------ *
 * The Roles and Recording panes — the world their rows tick over
 * ------------------------------------------------------------------ */

/** One `get_`/`put_` pair so a pattern reaches exactly one of them, a third name for a
 *  second pattern family, and one prompt — with no resource at all, so "a family the app
 *  has none of is omitted" has something to omit. */
const ROLE_TOOLS = [
  { name: "get_paper", description: "Read a paper.", inputSchema: { type: "object" } },
  { name: "put_paper", description: "Write a paper.", inputSchema: { type: "object" } },
  { name: "jobfeed_crawl", description: "Crawl the boards.", inputSchema: { type: "object" } },
];
const ROLE_PROMPTS = [{ name: "digest_daily", description: "The day's digest.", arguments: [] }];

/**
 * One tunneled app of the Roles pane's own: a real connect, so there is a catalog to tick
 * over and a `matches N` to compute, then the two maps the pane merges — the app's
 * declaration (`upsertDeclaredRoles`, which is what a connect writes) and the owner's
 * (`app_update { owner_roles }`, the only writer §1 gives it). The socket is closed
 * immediately: the cached catalog outlives it, which its own row pins.
 */
async function seedRoleApp(
  handle: string,
  spec: { declared?: RoleDeclaration; owner?: RoleDeclaration } = {},
): Promise<{ slug: string }> {
  const slug = uniqueSlug(handle);
  const close = await dialTunnel(slug, {
    capabilities: ["tools", "prompts"],
    tools: ROLE_TOOLS,
    prompts: ROLE_PROMPTS,
  });
  await close();
  const app = await new Registry(env.DB).getApp(detail.ns.owner.userId, slug);
  if (app === null) throw new Error(`the seeded role app "${slug}" vanished`);
  if (spec.declared !== undefined) await new Registry(env.DB).upsertDeclaredRoles(app.id, spec.declared);
  if (spec.owner !== undefined) {
    await ops.app_update.handler(detail.ns.owner.userId, { slug, owner_roles: spec.owner });
  }
  return { slug };
}

/** One agent holding one role on one app, so a holders' badge has a holder — created
 *  through the ops rather than through the seed, because the app already exists. */
async function grantRole(
  app: string,
  handle: string,
  role: string,
  mode: "allow" | "approval",
): Promise<string> {
  const slug = uniqueSlug(handle);
  await ops.agent_create.handler(detail.ns.owner.userId, { slug, name: slug });
  await ops.grant_set.handler(detail.ns.owner.userId, {
    agent: slug,
    app,
    roles: [mode === "allow" ? role : `${role}:approval`],
  });
  return slug;
}

/** The owner map as the STORE holds it — what a composed save is asserted against, rather
 *  than against the page's own redraw of it. */
async function ownerRolesOf(slug: string): Promise<RoleDeclaration> {
  return (await new Registry(env.DB).getApp(detail.ns.owner.userId, slug))?.ownerRoles ?? {};
}

/** Every checkbox a pane renders, as its name and whether it is ticked — the Roles and
 *  Recording editors' whole control surface, read without naming the element around it.
 *  A `disabled` box is reported too; `disabledBoxesOn` is what asks about that. */
function checkboxesOn(html: string): Record<string, boolean> {
  const found: Record<string, boolean> = {};
  for (const control of html.matchAll(/<input\b([^>]*)>/g)) {
    if (attributeOf(control[1], "type") !== "checkbox") continue;
    const name = decodeEntities(attributeOf(control[1], "name") ?? "");
    if (name === "") continue;
    found[name] = /\bchecked\b/.test(control[1]);
  }
  return found;
}

/** The names of the checkboxes a pane drew `disabled` — "the control is there and cannot
 *  be moved" is a different claim from "there is no control". */
function disabledBoxesOn(html: string): string[] {
  const found: string[] = [];
  for (const control of html.matchAll(/<input\b([^>]*)>/g)) {
    if (attributeOf(control[1], "type") !== "checkbox") continue;
    if (!/\bdisabled\b/.test(control[1])) continue;
    found.push(decodeEntities(attributeOf(control[1], "name") ?? ""));
  }
  return found;
}

/** The values of every submit control with one name — the editors' `drop`, `add` and
 *  `keep` rows, each of which is one button or one hidden field per row it belongs to. */
function valuesNamed(name: string, html: string): string[] {
  const found: string[] = [];
  for (const control of html.matchAll(/<(?:input|button)\b([^>]*)>/g)) {
    if (decodeEntities(attributeOf(control[1], "name") ?? "") !== name) continue;
    found.push(decodeEntities(attributeOf(control[1], "value") ?? ""));
  }
  return found;
}

describe(`§4/§20.3 · /apps/<slug> — the Roles pane and role_set`, () => {
  beforeAll(withAppDetailWorld);

  it(`§4 · the Roles listing header is the title Roles over "named sets of what this app exposes" and the summary "D declared by the app · Y yours · plus the built-in all" — tunneled adding " · the app's declaration wins when it declares a name you defined", proxied " · a proxied app declares none, so every role is yours" — and the LISTING carries no filter at all (the twin: the two kinds side by side)`, async () => {
    const tunneled = await seedRoleApp("rolehead", {
      declared: { app_role: ["get_.*"] },
      owner: { mine: { tools: ["put_paper"] } },
    });
    const html = await page(paths.appPane(tunneled.slug, "roles"), detail.session.cookie);
    const text = textOf(html);
    expect(text).toContain("Roles");
    expect(text).toContain(ROLES_SUB);
    expect(text).toContain("1 declared by the app · 1 yours · plus the built-in all");
    expect(text).toContain(ROLES_TUNNELED_TAIL);
    expect(text).not.toContain(ROLES_PROXIED_TAIL);
    // No filter on the LISTING — the editor's filter lives in the details and carries sel.
    expect(getFormsOn(html)).toEqual([]);

    // THE TWIN: the proxied kind, whose roles are all the owner's.
    const proxied = textOf(await appPage(paths.appPane(CATALOG, "roles")));
    expect(proxied).toContain(`0 declared by the app · ${Object.keys(CATALOG_ROLES).length} yours · plus the built-in all`);
    expect(proxied).toContain(ROLES_PROXIED_TAIL);
    expect(proxied).not.toContain(ROLES_TUNNELED_TAIL);
  });

  it(`§4 · one row per effective role with the built-in all LAST, each the name in mono under a source badge — built-in / app / "app · replaced yours" titled "the app declares this name — its declaration replaced yours" / "yours" as badge--success — over "tools a, b · prompts c · matches N" ("every tool, prompt and resource, present and future" for all), with one badge per agent holding it ("<agent>" / "<agent> · ask") or the dim "held by no agent"; the row IS the ?sel=role:<name> link and the foot's left carries New role → ?new=1`, async () => {
    const app = await seedRoleApp("rolerows", {
      declared: { app_role: ["get_.*"] },
      owner: { mine: { tools: ["put_paper"] }, app_role: { tools: ["jobfeed_crawl"] } },
    });
    const pane = paths.appPane(app.slug, "roles");
    await grantRole(app.slug, "holder", "mine", "allow");
    await grantRole(app.slug, "asker", "app_role", "approval");
    const html = await page(pane, detail.session.cookie);

    // One row per EFFECTIVE role, then `all` last — order read off the rows themselves.
    const drawn = selValuesOn(html, pane);
    expect([...drawn].sort()).toEqual(["role:all", "role:app_role", "role:mine"]);
    expect(drawn[drawn.length - 1], "the built-in is drawn last").toBe("role:all");

    const rows = Object.fromEntries(
      ["app_role", "mine", "all"].map((name) => [name, textOf(rowMarkupFor(html, `role:${name}`))]),
    );
    // The shadowed name: the app's declaration won, and the row says so.
    expect(rows.app_role).toContain(ROLE_REPLACED);
    expect(html).toContain(ROLE_REPLACED_TITLE);
    expect(rows.app_role).toContain("tools get_.*");
    expect(rows.app_role).toContain("matches 1");
    expect(rows.app_role).toContain("asker · ask");

    expect(rows.mine).toContain("yours");
    expect(rows.mine).toContain("matches 1");
    expect(rows.mine).toContain("holder");
    expect(rows.mine).not.toContain("holder · ask");

    expect(rows.all).toContain("built-in");
    expect(rows.all).toContain(ROLE_ALL_ITEMS);
    expect(rows.all).toContain(HELD_BY_NONE);

    // The foot's New role.
    expect(links(html, `${pane}?new=1`)).toBe(true);
  });

  it(`§4/§20.3 · a name the owner defined AND the app declares appears ONCE, its content the app's declaration and its badge "app · replaced yours" — effectiveRoles, the app on top, never a union of the two maps — while the owner's other names keep the "yours" badge and the app's other names keep "app" (the twin: the same owner map before the app declared that name)`, async () => {
    const app = await seedRoleApp("shadow", { owner: { clash: { tools: ["put_paper"] }, mine: { tools: ["get_paper"] } } });
    const pane = paths.appPane(app.slug, "roles");

    // BEFORE — the twin: the owner's own name, its own content, badged "yours".
    const before = await page(pane, detail.session.cookie);
    expect(textOf(rowMarkupFor(before, "role:clash"))).toContain("yours");
    expect(textOf(rowMarkupFor(before, "role:clash"))).toContain("put_paper");

    // The app declares the same name on its next connect, with DIFFERENT content.
    const row = await new Registry(env.DB).getApp(detail.ns.owner.userId, app.slug);
    if (row === null) throw new Error("the seeded role app vanished");
    await new Registry(env.DB).upsertDeclaredRoles(row.id, { clash: ["jobfeed_.*"], theirs: ["get_.*"] });

    const after = await page(pane, detail.session.cookie);
    // ONCE, not twice: a union would list `clash` on both sides of the summary.
    expect(selValuesOn(after, pane).filter((sel) => sel === "role:clash").length).toBe(1);
    const clash = textOf(rowMarkupFor(after, "role:clash"));
    expect(clash).toContain(ROLE_REPLACED);
    expect(clash).toContain("jobfeed_.*");
    expect(clash, "the app's declaration REPLACED the owner's, it did not merge with it").not.toContain(
      "put_paper",
    );
    // The neighbours keep their own sources.
    expect(textOf(rowMarkupFor(after, "role:mine"))).toContain("yours");
    const theirs = textOf(rowMarkupFor(after, "role:theirs"));
    expect(theirs).toContain("app");
    expect(theirs).not.toContain(ROLE_REPLACED);
  });

  it(`§4 · "matches N" is the count of catalog items the role's own patterns match, computed with the gate's own matcher: a literal role and a pattern role each carry their own N, a pattern reaching prompts and resources counts them too, and a role whose patterns match nothing today reads matches 0 rather than omitting the clause (the twin)`, async () => {
    const app = await seedRoleApp("matches", {
      owner: {
        // `get_.*` reaches one of the two tools; the literal reaches exactly itself;
        // `digest_.*` reaches the one prompt; and the last pattern reaches nothing today.
        pattern_role: { tools: ["get_.*"] },
        literal_role: { tools: ["put_paper"] },
        prompt_role: { prompts: ["digest_.*"] },
        empty_role: { tools: ["nothing_.*"] },
      },
    });
    const html = await page(paths.appPane(app.slug, "roles"), detail.session.cookie);
    expect(textOf(rowMarkupFor(html, "role:pattern_role"))).toContain("matches 1");
    expect(textOf(rowMarkupFor(html, "role:literal_role"))).toContain("matches 1");
    expect(textOf(rowMarkupFor(html, "role:prompt_role"))).toContain("matches 1");
    // THE TWIN: the clause is there and reads 0 rather than being left off.
    expect(textOf(rowMarkupFor(html, "role:empty_role"))).toContain("matches 0");
  });

  it(`§4 · the Roles details with nothing selected is "Select a role to see what it can do, or add one of your own." over the card "Two sources, one rule": "The app's" → tunneled "declared at connect; read-only here — the app owns them" / proxied "none: a proxied app declares no roles"; "Yours" → "defined here by ticking items or adding patterns; usable in grants like any role"; "Collision" → "if the app later declares a name you defined, its declaration replaces yours — the row says so"`, async () => {
    const app = await seedRoleApp("rolecard", { declared: { app_role: ["get_.*"] } });
    const tunneled = textOf(await page(paths.appPane(app.slug, "roles"), detail.session.cookie));
    expect(tunneled).toContain(ROLES_PROMPT);
    expect(tunneled).toContain("Two sources, one rule");
    expect(tunneled).toContain("declared at connect; read-only here — the app owns them");
    expect(tunneled).toContain(
      "defined here by ticking items or adding patterns; usable in grants like any role",
    );
    expect(tunneled).toContain(COLLISION_RULE);

    // The proxied arm of the same card.
    const proxied = textOf(await appPage(paths.appPane(CATALOG, "roles")));
    expect(proxied).toContain("none: a proxied app declares no roles");
    expect(proxied).not.toContain("declared at connect; read-only here — the app owns them");
  });

  it(`§4 · a selected app-declared role is read-only: the name, the "declared by the app" badge, its holders' badges and "Declared by <name> at connect. Read-only: the app owns it and may widen it on its next connect." — or, where it shadows one of the owner's, "<name> declares this name, so its declaration replaced the one you had defined. Read-only: the app owns it." — every item row drawn as a locked check titled "in this role" or an empty box titled "not in this role" and never a checkbox, no filter, no Add as pattern, no Delete role and no Save (the twin: the owner's own role beside it draws all of them)`, async () => {
    const app = await seedRoleApp("readonly", {
      declared: { app_role: ["get_.*"], shadowing: ["put_paper"] },
      owner: { shadowing: { tools: ["jobfeed_crawl"] }, mine: { tools: ["get_paper"] } },
    });
    const name = (await appRowOf(app.slug)).name;
    const pane = paths.appPane(app.slug, "roles");

    const declared = await page(`${pane}?sel=role:app_role`, detail.session.cookie);
    const declaredText = textOf(declared);
    expect(declaredText).toContain("declared by the app");
    expect(declaredText).toContain(appRoleExplained(name));
    // Read-only means read-only: no tick of any kind, and no form to submit one with.
    expect(declared).not.toContain('name="i.');
    expect(declared).not.toContain('name="drop"');
    expect(declared).not.toContain('name="add"');
    expect(declared).not.toContain('name="delete"');
    expect(opsOn(declared)).not.toContain("role_set");
    expect(declared).toContain("in this role");
    expect(declared).toContain("not in this role");
    expect(textOf(declared), "an app-declared role has no editor foot").not.toContain("Save");

    // The shadowing arm says WHOSE it replaced.
    const shadowed = textOf(await page(`${pane}?sel=role:shadowing`, detail.session.cookie));
    expect(shadowed).toContain(shadowedExplained(name));

    // THE TWIN: the owner's own role, on the same app, draws all of them.
    const mine = await page(`${pane}?sel=role:mine`, detail.session.cookie);
    expect(mine).toContain('name="i.');
    expect(opsOn(mine)).toContain("role_set");
  });

  it(`§4 · the built-in all's details read "Every tool, prompt and resource, present and future. Never declarable, only grantable." with no groups, no Patterns section and no form of any kind`, async () => {
    const app = await seedRoleApp("allrole", { owner: { mine: { tools: ["get_paper"] } } });
    const html = await page(`${paths.appPane(app.slug, "roles")}?sel=role:all`, detail.session.cookie);
    const text = textOf(html);
    expect(text).toContain("built-in");
    expect(text).toContain(ALL_EXPLAINED);
    expect(text).not.toContain(PATTERNS_LEGEND);
    expect(html).not.toContain('name="i.');
    expect(opsOn(html)).not.toContain("role_set");
    expect(text, "the built-in has no editor foot either").not.toContain("Discard");
  });

  it(`§4 · a selected role of the owner's own is editable: the explanation per kind — tunneled "Defined by you. If <name> later declares a role named <role>, the app's declaration replaces this one." / proxied "Defined by you. A proxied app declares no roles, so this is the only kind it has." — the filter (GET, q, placeholder "filter, or type a pattern…", carrying sel), the groups "Tools · K of N", "Prompts · K of N", "Resources · K of N" with K the count in the role and a family the app has none of omitted, and per row a checkbox <input type="checkbox" name="i.<family>/<name>" value="1"> checked at the literal, or a .cb.lock titled "matched by <patterns>" where a pattern already reaches it`, async () => {
    const app = await seedRoleApp("editable", {
      owner: { mine: { tools: ["put_paper", "get_.*"] } },
    });
    const name = (await appRowOf(app.slug)).name;
    const pane = paths.appPane(app.slug, "roles");
    const href = `${pane}?sel=role:mine`;
    const html = await page(href, detail.session.cookie);
    const text = textOf(html);

    expect(text).toContain(yoursTunneled(name, "mine"));
    expect(html).toContain('placeholder="filter, or type a pattern…"');
    expect(getFormsOn(html)).toContainEqual({ action: pane, fields: ["q", "sel"].sort() });

    // K of N per family, and the family the app declares none of is OMITTED.
    expect(text).toContain(`Tools · 2 of ${ROLE_TOOLS.length}`);
    expect(text).toContain(`Prompts · 0 of ${ROLE_PROMPTS.length}`);
    expect(text).not.toContain("Resources ·");

    // The literal is a ticked checkbox; the pattern-reached row is a LOCKED check, so a
    // save cannot silently turn a pattern's reach into a literal.
    const boxes = checkboxesOn(html);
    expect(boxes["i.tools/put_paper"]).toBe(true);
    expect(boxes["i.tools/get_paper"]).toBeUndefined();
    expect(html).toContain("cb lock");
    expect(html).toContain("matched by get_.*");
    // The editor foot, per the 2026-09-17 ruling: Discard and Save on every editable role.
    expect(text).toContain("Discard");
    expect(text).toContain("Save");
  });

  it(`§4 · "Patterns · N" is one row per non-literal pattern — the pattern, its family and "matches N today, and any added later" under the legend "anchored · * aliases .*" — each carrying a remove submit named drop with the value "<family>/<pattern>" while the role is editable and a locked check where it is not (the twin)`, async () => {
    const app = await seedRoleApp("patterns", {
      declared: { theirs: ["put_.*"] },
      owner: { mine: { tools: ["get_.*"] } },
    });
    const pane = paths.appPane(app.slug, "roles");
    const editable = await page(`${pane}?sel=role:mine`, detail.session.cookie);
    const text = textOf(editable);
    expect(text).toContain("Patterns · 1");
    expect(text).toContain(PATTERNS_LEGEND);
    expect(text).toContain("get_.*");
    expect(text).toContain("matches 1 today, and any added later");
    expect(valuesNamed("drop", editable)).toEqual(["tools/get_.*"]);
    // The pattern the form still lists rides the save as a `keep`.
    expect(paneSubmission(editable, actionFor(editable, "role_set"))["keep"]).toBe("tools/get_.*");

    // THE TWIN: the app's own role lists its pattern and offers no way to drop it.
    const readOnly = await page(`${pane}?sel=role:theirs`, detail.session.cookie);
    expect(textOf(readOnly)).toContain("put_.*");
    expect(valuesNamed("drop", readOnly)).toEqual([]);
  });

  it(`§4 · ?new=1 draws the new-role editor — an <input name="role"> with the placeholder "role name" and pattern [a-z0-9_-]+ in place of the name, an empty hidden was=, every checkbox unchecked, no Patterns rows and no Delete role — and the listing's New role link is what reaches it · a saved role's editor carries the hidden role, the hidden was=<name> and the Delete (the twin)`, async () => {
    const app = await seedRoleApp("newrole", { owner: { mine: { tools: ["get_.*"] } } });
    const pane = paths.appPane(app.slug, "roles");
    expect(links(await page(pane, detail.session.cookie), `${pane}?new=1`)).toBe(true);

    const fresh = await page(`${pane}?new=1`, detail.session.cookie);
    expect(fresh).toContain('placeholder="role name"');
    expect(fresh).toContain('pattern="[a-z0-9_-]+"');
    const submitted = paneSubmission(fresh, actionFor(fresh, "role_set"));
    expect(submitted["was"]).toBe("");
    const ticked = Object.entries(checkboxesOn(fresh)).filter(([, on]) => on);
    expect(ticked.filter(([name]) => name.startsWith("i."))).toEqual([]);
    expect(fresh).not.toContain('name="delete"');
    expect(textOf(fresh)).not.toContain(DELETE_ROLE_HINT);
    // The editor foot is Discard and Save for EVERY editable role, the new one included.
    expect(textOf(fresh)).toContain("Discard");
    expect(textOf(fresh)).toContain("Save");
    expect(links(fresh, pane), "Discard is a link back to the pane").toBe(true);

    // THE TWIN: a saved role's editor names itself and offers the delete.
    const saved = await page(`${pane}?sel=role:mine`, detail.session.cookie);
    const savedFields = paneSubmission(saved, actionFor(saved, "role_set"));
    expect(savedFields["was"]).toBe("mine");
    expect(savedFields["role"]).toBe("mine");
    expect(saved).toContain('name="delete"');
    expect(textOf(saved)).toContain(DELETE_ROLE_HINT);
  });

  it(`§4 · with q a NON-literal the editor offers the row "<q> · tools · would match N today, and any added later" with Add as pattern (name="add" value="<q>"), the family reading resources where q carries :// and tools otherwise · a literal q filters the rows and offers nothing (the twin)`, async () => {
    const app = await seedRoleApp("offer", { owner: { mine: { tools: ["put_paper"] } } });
    const href = `${paths.appPane(app.slug, "roles")}?sel=role:mine`;

    const offered = await page(`${href}&q=${encodeURIComponent("get_.*")}`, detail.session.cookie);
    expect(textOf(offered)).toContain("would match 1 today, and any added later");
    expect(valuesNamed("add", offered)).toEqual(["get_.*"]);

    // A URI-shaped q is offered as a RESOURCE pattern rather than a tool one.
    const uriShaped = await page(
      `${href}&q=${encodeURIComponent("news://feed/*")}`,
      detail.session.cookie,
    );
    expect(valuesNamed("add", uriShaped)).toEqual(["news://feed/*"]);
    expect(textOf(uriShaped)).toContain("resources");

    // THE TWIN: a literal q filters and offers nothing to add.
    const literal = await page(`${href}&q=get_paper`, detail.session.cookie);
    expect(textOf(literal)).toContain("get_paper");
    expect(valuesNamed("add", literal)).toEqual([]);
  });

  it(`§4/§8 · role_set composes ONE app_update: the stored owner map, minus was, plus role → per family the checked i. literals + the keep patterns − drop + add, empty families omitted — writing owner_roles on a TUNNELED app and roles on a PROXIED one and never both — then lands 303 on /apps/<slug>/roles?sel=role:<name> with the notice · a pattern the form still lists survives a save that did not touch it, through its hidden keep=<family>/<pattern> (the twin: the same save with the keep fields dropped loses it)`, async () => {
    const app = await seedRoleApp("compose", {
      owner: { mine: { tools: ["put_paper", "get_.*"] }, untouched: { tools: ["jobfeed_crawl"] } },
    });
    const pane = paths.appPane(app.slug, "roles");
    const html = await page(`${pane}?sel=role:mine`, detail.session.cookie);
    const target = actionFor(html, "role_set");

    // Submitted exactly as the browser submits it, plus one new tick.
    const fields = { ...paneSubmission(html, target), "i.tools/jobfeed_crawl": "1" };
    const posted = await formPost(target, fields, detail.session.cookie);
    expect(posted.status).toBe(303);
    const landed = new URL(posted.headers.get("Location") ?? "", ORIGIN);
    expect(landed.pathname).toBe(pane);
    expect(landed.searchParams.get("sel")).toBe("role:mine");
    expect(landed.searchParams.get("done")).toBe("role_set");

    const saved = await ownerRolesOf(app.slug);
    expect(saved.mine).toEqual(["get_.*", "jobfeed_crawl", "put_paper"]);
    // The role the form did not name is untouched — the composition is of the STORED map.
    expect(saved.untouched).toEqual(["jobfeed_crawl"]);
    // A TUNNELED app writes `owner_roles`: its declaration map stays empty.
    const row = await new Registry(env.DB).getApp(detail.ns.owner.userId, app.slug);
    expect(row?.declaredRoles ?? {}).toEqual({});

    // THE TWIN: the same submission WITHOUT the keep fields loses exactly the pattern.
    const again = await page(`${pane}?sel=role:mine`, detail.session.cookie);
    const bare = { ...paneSubmission(again, actionFor(again, "role_set")) };
    delete bare["keep"];
    expect((await formPost(actionFor(again, "role_set"), bare, detail.session.cookie)).status).toBe(303);
    expect((await ownerRolesOf(app.slug)).mine).toEqual(["jobfeed_crawl", "put_paper"]);
  });

  it(`§4/§8 · Delete role posts delete=1 and composes the stored map minus was ALONE — no other role changes and no dialog, the hint beside it reading "grants naming it keep the name and match nothing until it exists again" — landing 303 on /apps/<slug>/roles; a grant naming the deleted role keeps the name and matches nothing until it exists again (the twin)`, async () => {
    const app = await seedRoleApp("deleterole", {
      owner: { doomed: { tools: ["get_paper"] }, keeper: { tools: ["put_paper"] } },
    });
    const agent = await grantRole(app.slug, "deleteholder", "doomed", "allow");
    const pane = paths.appPane(app.slug, "roles");
    const html = await page(`${pane}?sel=role:doomed`, detail.session.cookie);
    const target = actionFor(html, "role_set");
    // No dialog: the control is on the pane itself, because re-adding undoes it.
    expect(confirmLinksOn(html)).toEqual([]);

    const posted = await formPost(
      target,
      pressed(html, target, "delete", "1"),
      detail.session.cookie,
    );
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe(`${pane}?done=role_set`);

    const saved = await ownerRolesOf(app.slug);
    expect(Object.keys(saved)).toEqual(["keeper"]);
    // THE TWIN: the grant keeps the NAME and matches nothing until it exists again.
    const held = (await ops.agent_list.handler(detail.ns.owner.userId, {})) as {
      agents: { slug: string; grants: Record<string, string[]> }[];
    };
    expect(held.agents.find((row) => row.slug === agent)?.grants[app.slug]).toContain("doomed");
    expect(textOf(await page(pane, detail.session.cookie))).not.toContain("doomed");
  });

  it(`§4/§9 · a refused role_set redraws the pane at 400 with the reason in a danger alert and every submitted choice preserved, never a bare error page and never a partial write: an empty or illegal name, the reserved all, a pattern that does not compile, and — on a tunneled app — a name the app declares, refused with "<name> is declared by the app — its declaration would replace yours"; after each the stored map is byte-identical to what it was (the twin)`, async () => {
    const app = await seedRoleApp("refuse", {
      declared: { theirs: ["get_.*"] },
      owner: { mine: { tools: ["put_paper"] } },
    });
    const pane = paths.appPane(app.slug, "roles");
    const before = JSON.stringify(await ownerRolesOf(app.slug));

    const html = await page(`${pane}?new=1`, detail.session.cookie);
    const target = actionFor(html, "role_set");
    const base = paneSubmission(html, target);
    for (const [role, because] of [
      ["", "an empty name"],
      ["Not A Role", "an illegal name"],
      ["all", "the reserved name"],
      ["theirs", "a name the app declares"],
    ] as const) {
      const refused = await formPost(
        target,
        { ...base, role, "i.tools/put_paper": "1" },
        detail.session.cookie,
      );
      expect(refused.status, because).toBe(400);
      const body = await refused.text();
      // The PANE is redrawn, not a bare error page: the listing is still there…
      expect(textOf(body), because).toContain(ROLES_SUB);
      // …the choice the owner made is still ticked…
      expect(checkboxesOn(body)["i.tools/put_paper"], because).toBe(true);
      // …and nothing was written.
      expect(JSON.stringify(await ownerRolesOf(app.slug)), because).toBe(before);
    }
    // The collision names the app's declaration in the brief's own words.
    const collided = await formPost(target, { ...base, role: "theirs" }, detail.session.cookie);
    expect(textOf(await collided.text())).toContain(declaredByApp("theirs"));
  });

  it(`§4/§8 · owner_roles is for tunneled apps: the proxied app's Roles editor posts roles and its app_update refuses owner_roles with "owner_roles is for tunneled apps — a proxied app's roles are \`roles\`", while the tunneled app's editor posts owner_roles and leaves roles_json untouched (the twin — the page never mixes them)`, async () => {
    // The PROXIED half, on this describe's own app so the shared world keeps its roles.
    const proxied = uniqueSlug("kindprx");
    const scenario: UpstreamScenario = { id: uniqueSlug("kindup"), mode: { kind: "ok" } };
    await registerOverride(scenario.id, { tools: ROLE_TOOLS });
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: proxied,
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(scenario),
          upstreamAuthMode: "headers",
          roles: { mine: { tools: ["put_paper"] } },
        },
      ],
    });
    const { cookie } = await seedOwnerSession(ns.owner);
    const html = await page(`${paths.appPane(proxied, "roles")}?sel=role:mine`, cookie);
    const target = actionFor(html, "role_set");
    const posted = await formPost(
      target,
      { ...paneSubmission(html, target), "i.tools/get_paper": "1" },
      cookie,
    );
    expect(posted.status).toBe(303);
    const row = await new Registry(env.DB).getApp(ns.owner.userId, proxied);
    expect(row?.declaredRoles.mine).toEqual(["get_paper", "put_paper"]);
    expect(row?.ownerRoles ?? {}, "a proxied app's owner map stays empty").toEqual({});
    // The op agrees, in the brief's own words.
    await expect(
      ops.app_update.handler(ns.owner.userId, { slug: proxied, owner_roles: { mine: ["get_.*"] } }),
    ).rejects.toThrow(/owner_roles is for tunneled apps/);

    // THE TWIN: the tunneled app writes the OTHER map and leaves the declaration alone.
    const tunneled = await seedRoleApp("kindtun", { owner: { mine: { tools: ["put_paper"] } } });
    const tunnelHtml = await page(
      `${paths.appPane(tunneled.slug, "roles")}?sel=role:mine`,
      detail.session.cookie,
    );
    const tunnelTarget = actionFor(tunnelHtml, "role_set");
    expect(
      (await formPost(
        tunnelTarget,
        { ...paneSubmission(tunnelHtml, tunnelTarget), "i.tools/get_paper": "1" },
        detail.session.cookie,
      )).status,
    ).toBe(303);
    const tunnelRow = await new Registry(env.DB).getApp(detail.ns.owner.userId, tunneled.slug);
    expect(tunnelRow?.ownerRoles.mine).toEqual(["get_paper", "put_paper"]);
    expect(tunnelRow?.declaredRoles ?? {}).toEqual({});
  });
});


/**
 * The Recording pane's own catalog: one path THREE tools take (so "indexed once, sorted by
 * how many tools take it" has something to sort and something to expand), one path a single
 * tool takes, one the app declares `writeOnly` (so a path with no editable tool exists at
 * all), and one tool with an outputSchema beside two without (so the Results section has
 * both a path and its "mask from evidence" note).
 */
const RECORD_TOOLS = [
  {
    name: "alpha_call",
    description: "One.",
    inputSchema: {
      type: "object",
      properties: {
        token: { type: "string", writeOnly: true },
        note: { type: "string" },
        shared: { type: "string" },
      },
    },
  },
  {
    name: "beta_call",
    description: "Two.",
    inputSchema: {
      type: "object",
      properties: { shared: { type: "string" }, only_beta: { type: "number" } },
    },
  },
  {
    name: "gamma_call",
    description: "Three.",
    inputSchema: { type: "object", properties: { shared: { type: "string" } } },
    outputSchema: { type: "object", properties: { out: { type: "string" } } },
  },
] as const;

/** One tunneled app of the Recording pane's own — a real connect for the cached schemas,
 *  then §7's stored maps through the one op that writes them. */
async function seedRecordingApp(
  handle: string,
  spec: {
    redact?: Record<string, string[]>;
    redactResults?: Record<string, string[]>;
    logBodies?: boolean;
  } = {},
): Promise<{ slug: string }> {
  const slug = uniqueSlug(handle);
  const close = await dialTunnel(slug, {
    capabilities: ["tools"],
    tools: RECORD_TOOLS as unknown as { name: string; [key: string]: unknown }[],
  });
  await close();
  const patch: Record<string, unknown> = { slug };
  if (spec.redact !== undefined) patch.redact = spec.redact;
  if (spec.redactResults !== undefined) patch.redact_results = spec.redactResults;
  if (spec.logBodies !== undefined) patch.log_bodies = spec.logBodies;
  if (Object.keys(patch).length > 1) await ops.app_update.handler(detail.ns.owner.userId, patch);
  return { slug };
}

/** §7's two stored maps as the STORE holds them — what a composed save is asserted
 *  against, rather than against the page's own redraw of it. */
async function redactionOf(
  slug: string,
): Promise<{ redact: Record<string, string[]>; redactResults: Record<string, string[]> }> {
  const app = await new Registry(env.DB).getApp(detail.ns.owner.userId, slug);
  if (app === null) throw new Error(`the recording app "${slug}" vanished`);
  return { redact: app.redact, redactResults: app.redactResults };
}

/** The markup ONE of a pane's post forms wraps — the Recording and Roles panes each put a
 *  whole listing or editor inside theirs, and "in the listing" is otherwise unsayable. */
function listingFormOf(html: string, op: string): string {
  const form = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].find((candidate) =>
    decodeEntities(attributeOf(candidate[1], "action") ?? "").includes(`/${op}`),
  );
  if (form === undefined) throw new Error(`the pane renders no "${op}" form`);
  return form[2];
}

/** The paths one Recording section drew, in the order it drew them — read off the controls
 *  each row carries (`p.<dir>.<path>`, or the `m.` rows of a path rendered expanded),
 *  because a mixed path has no `p.` field by design and must still count as a row. */
function pathRowOrder(html: string, dir: "args" | "results"): string[] {
  const order: string[] = [];
  for (const control of listingFormOf(html, "recording_set").matchAll(/<input\b([^>]*)>/g)) {
    const name = decodeEntities(attributeOf(control[1], "name") ?? "");
    const path = name.startsWith(`p.${dir}.`)
      ? name.slice(`p.${dir}.`.length)
      : name.startsWith(`m.${dir}.`)
        ? name.slice(`m.${dir}.`.length).split(".").slice(1).join(".")
        : "";
    if (path !== "" && !order.includes(path)) order.push(path);
  }
  return order;
}

/** One path row's own text, sliced out of its section — which is what makes a per-row claim
 *  an assertion about THAT row rather than about the pane. */
function pathRow(html: string, dir: "args" | "results", path: string): string {
  const listing = textOf(listingFormOf(html, "recording_set"));
  const results = listing.indexOf("Results ·");
  const section = dir === "args" ? listing.slice(0, results < 0 ? undefined : results) : listing.slice(results);
  return blocksOf(section, pathRowOrder(html, dir))[path] ?? "";
}

/** The `which` values a Recording pane's own links carry — the expand/hide control, read
 *  as what it opens rather than as the bytes the renderer encoded it in. */
function whichValuesOn(html: string): string[] {
  const found: string[] = [];
  for (const anchor of html.matchAll(/<a\b([^>]*)>/g)) {
    const href = decodeEntities(attributeOf(anchor[1], "href") ?? "");
    if (href === "") continue;
    for (const value of new URL(href, ORIGIN).searchParams.getAll("which")) found.push(value);
  }
  return [...new Set(found)];
}

describe(`§5/§15 · /apps/<slug> — the Recording pane and recording_set`, () => {
  beforeAll(withAppDetailWorld);

  it(`§5 · the Recording listing header is the title Recording over "what the audit trail keeps, and what it masks", the switch Record call bodies at the right edge as a REAL <input type="checkbox" name="log" value="1"> with its label text visible, the summary "body logging on|off · <kind> default | set explicitly · M masked path(s) by config" with " · W declared writeOnly by the app" only where any are, and the filter (GET, q, placeholder "filter paths…")`, async () => {
    const app = await seedRecordingApp("rechead", { redact: { alpha_call: ["note"] } });
    const pane = paths.appPane(app.slug, "recording");
    const html = await page(pane, detail.session.cookie);
    const text = textOf(html);
    expect(text).toContain("Recording");
    expect(text).toContain(RECORDING_SUB);
    expect(text).toContain(RECORD_BODIES);
    // A REAL checkbox, so the pane works with scripting off.
    expect(checkboxesOn(html).log).toBe(true);
    expect(html).toContain('name="log" value="1"');
    // Tunneled apps log by default, and the app declares one writeOnly path.
    expect(text).toContain("body logging on · tunneled default · 1 masked path by config");
    expect(text).toContain("· 1 declared writeOnly by the app");
    expect(html).toContain('placeholder="filter paths…"');
    expect(getFormsOn(html)).toContainEqual({ action: pane, fields: ["q"] });
  });

  it(`§5 · a proxied app with logging on and nothing masked carries the warning "A proxied app's schema is not cached at call time, so nothing is masked automatically. Tick what is secret before you save, or it is stored in the clear for 7 days." above the sections · the same app with something masked, and a tunneled app in the same state, carry none (the twin)`, async () => {
    const slug = uniqueSlug("warnprx");
    const scenario: UpstreamScenario = { id: uniqueSlug("warnup"), mode: { kind: "ok" } };
    await registerOverride(scenario.id, { tools: [...RECORD_TOOLS] });
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug,
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(scenario),
          upstreamAuthMode: "headers",
          logBodies: true,
        },
      ],
    });
    const { cookie } = await seedOwnerSession(ns.owner);
    const pane = paths.appPane(slug, "recording");
    expect(textOf(await page(pane, cookie))).toContain(PROXIED_UNMASKED);

    // The same app, once something IS masked: the warning is spent.
    await ops.app_update.handler(ns.owner.userId, { slug, redact: { alpha_call: ["note"] } });
    expect(textOf(await page(pane, cookie))).not.toContain(PROXIED_UNMASKED);

    // THE TWIN: a tunneled app logging with nothing masked carries none — its schema IS
    // cached at call time, which is the whole reason the warning exists.
    const tunneled = await seedRecordingApp("warntun", {});
    expect(
      textOf(await page(paths.appPane(tunneled.slug, "recording"), detail.session.cookie)),
    ).not.toContain(PROXIED_UNMASKED);
  });

  it(`§5 · the two sections are "Arguments · N path(s)" (from each tool's inputSchema) and "Results · N path(s)" (from outputSchema, where declared), each path indexed ONCE over every tool's schemaLeaves and sorted by how many tools take it then by name — a row being the path in mono, its type, "T tool(s)", then " · declared writeOnly[ on K]" or " · masked on its tool | all T | K of T" (the twin: a path two tools take is one row, not two)`, async () => {
    const app = await seedRecordingApp("recsections", { redact: { alpha_call: ["note"] } });
    const html = await page(paths.appPane(app.slug, "recording"), detail.session.cookie);
    const text = textOf(html);
    // The paths, indexed once over every tool and sorted by how many take them.
    expect(text).toContain("Arguments · 4 paths");
    // The singular, on the same render, so the rule is pinned and not one spelling.
    expect(text).toContain("Results · 1 path");
    expect(text).toContain("from each tool's inputSchema");
    expect(text).toContain("from outputSchema, where declared");

    // ONE row per path, in the sorted order — the twin is `shared`, which three tools take.
    expect(pathRowOrder(html, "args")).toEqual(["shared", "note", "only_beta", "token"]);
    const shared = (pathRow(html, "args", "shared"));
    expect(shared).toContain("string");
    expect(shared).toContain("3 tools");
    expect(pathRow(html, "args", "only_beta")).toContain("1 tool");
    // `note` is masked on the one tool that takes it.
    expect((pathRow(html, "args", "note"))).toContain("masked on its tool");
    // `token` is the app's own declaration.
    expect((pathRow(html, "args", "token"))).toContain("declared writeOnly");
  });

  it(`§5 · a path's control is a checkbox named p.<dir>.<path> with value 1, checked exactly when every EDITABLE tool masks it, and disabled and locked where no tool is editable because all of them declare it writeOnly · a path no tool masks is unchecked and enabled (the twin)`, async () => {
    const app = await seedRecordingApp("recbox", {
      redact: { alpha_call: ["shared"], beta_call: ["shared"], gamma_call: ["shared"] },
    });
    const html = await page(paths.appPane(app.slug, "recording"), detail.session.cookie);
    const boxes = checkboxesOn(html);
    // Masked on EVERY editable tool → checked.
    expect(boxes["p.args.shared"]).toBe(true);
    // THE TWIN: a path nothing masks → present, unchecked, and not disabled.
    expect(boxes["p.args.only_beta"]).toBe(false);
    expect(disabledBoxesOn(html)).not.toContain("p.args.only_beta");
    // The all-writeOnly path has no editable tool at all, so its box cannot be moved.
    expect(disabledBoxesOn(html)).toContain("p.args.token");
  });

  it(`§5 · a path masked on SOME but not all of its tools renders EXPANDED with no p. field at all — its per-tool rows shown and the path checkbox replaced by the locked-mixed glyph — so no save can silently clear a partial state · the same path masked on every tool renders collapsed and checked (the twin)`, async () => {
    const partial = await seedRecordingApp("recmixed", { redact: { alpha_call: ["shared"] } });
    const mixed = await page(paths.appPane(partial.slug, "recording"), detail.session.cookie);
    const boxes = checkboxesOn(mixed);
    // NO `p.` field: a save cannot carry an unticked box that would clear the partial set.
    expect(boxes["p.args.shared"]).toBeUndefined();
    expect(mixed).toContain("cb mixed");
    // Its per-tool rows are open without anyone asking, and each is its own control.
    expect(boxes["m.args.alpha_call.shared"]).toBe(true);
    expect(boxes["m.args.beta_call.shared"]).toBe(false);
    expect(boxes["m.args.gamma_call.shared"]).toBe(false);
    expect(textOf(mixed)).toContain(`${RECORD_TOOLS[1].name}`);

    // THE TWIN: masked on EVERY tool, the same path collapses to one ticked box.
    const whole = await seedRecordingApp("recwhole", {
      redact: { alpha_call: ["shared"], beta_call: ["shared"], gamma_call: ["shared"] },
    });
    const collapsed = await page(paths.appPane(whole.slug, "recording"), detail.session.cookie);
    expect(checkboxesOn(collapsed)["p.args.shared"]).toBe(true);
    expect(checkboxesOn(collapsed)["m.args.beta_call.shared"]).toBeUndefined();
  });

  it(`§5 · ?which=args:<path> and ?which=results:<path> expand one path's per-tool rows and turn that path's link into "hide", repeatable so two paths open at once, and the link is drawn only where more than one tool takes the path or any tool declares it writeOnly — an expanded sub-row being the tool name with "declared by the app — always masked" and a locked check where the tool declares it writeOnly, else a checkbox named m.<dir>.<tool>.<path> (the twin: a path one tool takes and nobody declares carries no which link)`, async () => {
    const app = await seedRecordingApp("recwhich", {});
    const pane = paths.appPane(app.slug, "recording");
    const closed = await page(pane, detail.session.cookie);
    // The link is drawn where the path is shared, or declared — and nowhere else.
    expect(whichValuesOn(closed).sort()).toEqual(["args:shared", "args:token"]);
    expect(checkboxesOn(closed)["m.args.beta_call.shared"]).toBeUndefined();

    const open = await page(`${pane}?which=args:shared`, detail.session.cookie);
    expect(checkboxesOn(open)["m.args.alpha_call.shared"]).toBe(false);
    expect(checkboxesOn(open)["m.args.beta_call.shared"]).toBe(false);
    expect(textOf(open)).toContain("hide");

    // Repeatable: two directions open at once, each drawing its own rows.
    const both = await page(`${pane}?which=args:shared&which=args:token`, detail.session.cookie);
    expect(checkboxesOn(both)["m.args.beta_call.shared"]).toBe(false);
    // The declared one is always masked and says so, with no checkbox of its own.
    expect(textOf(both)).toContain(ALWAYS_MASKED);
    expect(checkboxesOn(both)["m.args.alpha_call.token"]).toBeUndefined();
  });

  it(`§5 · under Results, where the tools declare no output schema and q is empty, the note "<tools or "N tools"> declare no output schema — a result path there can only come from a recorded call (mask from evidence)." · an empty section reads "no path matches" under a filter and "no schema declares any field" without one (the twin)`, async () => {
    const app = await seedRecordingApp("recnote", {});
    const pane = paths.appPane(app.slug, "recording");
    const text = textOf(await page(pane, detail.session.cookie));
    // Two of the three tools declare none, and the note names them.
    expect(text).toContain("declare no output schema — a result path there can only come from a recorded call (mask from evidence).");
    expect(text).toContain(RECORD_TOOLS[0].name);

    // Filtered to nothing: "no path matches", and the note is gone with the filter.
    const filtered = textOf(await page(`${pane}?q=${uniqueSlug("nomatch")}`, detail.session.cookie));
    expect(filtered).toContain(NO_PATH_MATCHES);
    expect(filtered).not.toContain(NO_SCHEMA_FIELDS);

    // THE TWIN: an app whose tools declare nothing at all reads the other sentence.
    const bare = uniqueSlug("recbare");
    const close = await dialTunnel(bare, {
      capabilities: ["tools"],
      tools: [{ name: "bare_call", description: "Nothing.", inputSchema: { type: "object" } }],
    });
    try {
      expect(textOf(await appPage(paths.appPane(bare, "recording")))).toContain(NO_SCHEMA_FIELDS);
    } finally {
      await close();
    }
  });

  it(`§5 · the Recording details are "Masked before recording" over "These fields are replaced with ‹redacted› before a call is written to the trail. Everything else in the body is kept as sent." — or, with logging off, "Body logging is off, so no bodies reach the trail; the masks below apply once it is turned on." — then one card per direction, "Arguments · N masked" and "Results · N masked", listing each masked path with "on <tools>" ("N tools" past three) and "declared writeOnly by <tools>", or "nothing masked — arguments|results are recorded whole" (the twin)`, async () => {
    const app = await seedRecordingApp("recdetails", { redact: { alpha_call: ["note"] } });
    const text = textOf(await page(paths.appPane(app.slug, "recording"), detail.session.cookie));
    expect(text).toContain("Masked before recording");
    expect(text).toContain(MASKED_BEFORE);
    expect(text).not.toContain(LOGGING_OFF_NOTE);
    expect(text).toContain("Arguments · 2 masked");
    expect(text).toContain(`on ${RECORD_TOOLS[0].name}`);
    expect(text).toContain(`declared writeOnly by ${RECORD_TOOLS[0].name}`);
    // Nothing is masked in the other direction, so that card says so.
    expect(text).toContain("nothing masked — results are recorded whole");

    // THE TWIN: the same pane with logging off says the masks are waiting.
    const off = await seedRecordingApp("recoff", { logBodies: false });
    const offText = textOf(await page(paths.appPane(off.slug, "recording"), detail.session.cookie));
    expect(offText).toContain(LOGGING_OFF_NOTE);
    expect(offText).not.toContain(MASKED_BEFORE);
  });

  it(`§5 · the card "What a recorded call keeps" is verbatim — Arguments → "params.arguments, post-redaction"; Results → "structuredContent post-redaction; text, image and resource blocks become size stubs, never bytes"; Cap → "16 KiB per body — an over-cap body is one oversize stub"; Kept for → "7 days, then pruned with the rest of the audit table · Export JSONL to keep longer" linking the audit export; Never → "refused calls, token material, writeOnly and config-masked fields" — over the note "A tick writes one literal (tool, path) entry per tool; nothing here is a pattern and nothing is typed. Masking applies to the approval record too.", with the foot's left reading "Recorded calls to <slug> →" linking /audit?app=<slug>`, async () => {
    const app = await seedRecordingApp("reckeeps", {});
    const html = await page(paths.appPane(app.slug, "recording"), detail.session.cookie);
    const text = textOf(html);
    expect(text).toContain("What a recorded call keeps");
    expect(text).toContain(pinned("params.arguments, post-redaction"));
    expect(text).toContain(
      pinned("structuredContent post-redaction; text, image and resource blocks become size stubs, never bytes"),
    );
    expect(text).toContain(KEEPS_CAP);
    expect(text).toContain("7 days, then pruned with the rest of the audit table · Export JSONL to keep longer");
    expect(text).toContain(KEEPS_NEVER);
    expect(text).toContain(RECORDING_NOTE);
    // The foot links the trail this pane is about.
    expect(text).toContain(`Recorded calls to ${app.slug} →`);
    expect(links(html, `${paths.audit}?app=${app.slug}`)).toBe(true);
  });

  it(`§5/§8 · recording_set composes ONE app_update { slug, log_bodies, redact, redact_results }: each ticked p. path becomes an entry on every editable tool that takes it, each ticked m. becomes that tool alone, and every hidden keep.<dir>=<tool>:<path> — the stored entries no schema row represents, added from evidence or keyed by a pattern — survives the save untouched · the same submission with the keep fields dropped loses exactly those entries (the twin)`, async () => {
    // One stored entry no schema row can represent: a PATTERN key, which the rows never
    // draw, so it exists only as a `keep`.
    const app = await seedRecordingApp("reccompose", { redact: { "alpha_.*": ["ghost"] } });
    const pane = paths.appPane(app.slug, "recording");
    const html = await page(pane, detail.session.cookie);
    const target = actionFor(html, "recording_set");
    const submitted = paneSubmission(html, target);
    expect(Object.keys(submitted)).toContain("keep.args");

    const posted = await formPost(
      target,
      { ...submitted, "p.args.shared": "1", "m.args.beta_call.only_beta": "1" },
      detail.session.cookie,
    );
    expect(posted.status).toBe(303);
    const saved = await redactionOf(app.slug);
    // A `p.` tick is one literal entry per editable tool that takes the path.
    for (const tool of RECORD_TOOLS.map((row) => row.name)) {
      expect(saved.redact[tool] ?? [], tool).toContain("shared");
    }
    // An `m.` tick is that tool alone.
    expect(saved.redact.beta_call).toContain("only_beta");
    expect(saved.redact.alpha_call ?? []).not.toContain("only_beta");
    // The pattern-keyed entry survived, untouched.
    expect(saved.redact["alpha_.*"]).toEqual(["ghost"]);

    // THE TWIN: the same submission with the keeps dropped loses exactly that entry.
    const again = await page(pane, detail.session.cookie);
    const bare = { ...paneSubmission(again, actionFor(again, "recording_set")) };
    delete bare["keep.args"];
    expect((await formPost(actionFor(again, "recording_set"), bare, detail.session.cookie)).status).toBe(303);
    expect((await redactionOf(app.slug)).redact["alpha_.*"]).toBeUndefined();
  });

  it(`§5/§9 · the switch is the save: recording_set posted with log unticked turns body logging off and with it ticked turns it on, each landing 303 back on the pane with the notice and the summary line reading the new state · a refused save redraws the pane at 400 with the reason and every submitted tick preserved (the twin)`, async () => {
    const app = await seedRecordingApp("recswitch", {});
    const pane = paths.appPane(app.slug, "recording");
    const on = await page(pane, detail.session.cookie);
    const target = actionFor(on, "recording_set");

    // A browser omits an unticked checkbox, which is the whole mechanism of the switch.
    const turnedOff = await formPost(target, unticked(paneSubmission(on, target)), detail.session.cookie);
    expect(turnedOff.status).toBe(303);
    expect(turnedOff.headers.get("Location")).toBe(`${pane}?done=recording_set`);
    const off = await page(pane, detail.session.cookie);
    expect(textOf(off)).toContain("body logging off");
    expect(checkboxesOn(off).log).toBe(false);

    // …and back on, through the same form.
    const backOn = await formPost(
      target,
      { ...unticked(paneSubmission(off, actionFor(off, "recording_set"))), log: "1" },
      detail.session.cookie,
    );
    expect(backOn.status).toBe(303);
    expect(textOf(await page(pane, detail.session.cookie))).toContain("body logging on");

    // THE TWIN: a refusal redraws the pane at 400 with the tick preserved. `redact`'s own
    // validation is what refuses — a path key no tool could ever carry.
    const live = await page(pane, detail.session.cookie);
    const refused = await formPost(
      actionFor(live, "recording_set"),
      { ...paneSubmission(live, actionFor(live, "recording_set")), "keep.args": "NOT A TOOL:x" },
      detail.session.cookie,
    );
    expect(refused.status).toBe(400);
    const body = await refused.text();
    expect(textOf(body)).toContain(RECORDING_SUB);
    expect(checkboxesOn(body).log).toBe(true);
  });
});

describe(`§6 · /apps/<slug> — the Agents pane and grant_set`, () => {
  beforeAll(withAppDetailWorld);
  beforeAll(async () => {
    access = await seedAccessWorld();
  });

  it(`§6 · the Agents listing header is the title Agents over "who can call this app, and how" and the summary "N agent(s) hold a grant · open one to edit its grant on <slug>", over exactly the agents holding ≥1 grant on THIS app read from agent_list's inline grants, with the rail's Agents marker the number of rows it drew · an agent granted only on another app is absent here and present on that app's own pane (the twin)`, async () => {
    // Ground truth from the op, so the absence below is FILTERING rather than an empty
    // namespace: all three agents exist and all three are listed by agent_list.
    const listed = (await ops.agent_list.handler(access.ownerId, {})) as { agents: { slug: string }[] };
    const known = listed.agents.map((agent) => agent.slug);
    for (const slug of Object.values(ACCESS_SLUG)) expect(known, slug).toContain(slug);

    const alphaPane = paths.appPane(ALPHA, "access");
    const alphaHtml = await page(alphaPane, access.cookie);
    const alpha = textOf(alphaHtml);
    expect(alpha).toContain("Agents");
    expect(alpha).toContain(AGENTS_SUB);
    expect(alpha).toContain(`2 agents hold a grant · open one to edit its grant on ${ALPHA}`);
    expect(alpha).toContain(ACCESS_SLUG.claude);
    expect(alpha).toContain(ACCESS_SLUG.pi);
    expect(alpha).not.toContain(ACCESS_SLUG.stray);
    expect(markerOn(alphaHtml, alphaPane)).toBe("2");

    // THE TWIN: one agent_list, two panes, two answers.
    const betaPane = paths.appPane(BETA, "access");
    const betaHtml = await page(betaPane, access.cookie);
    const beta = textOf(betaHtml);
    expect(beta).toContain(`1 agent holds a grant · open one to edit its grant on ${BETA}`);
    expect(beta).toContain(ACCESS_SLUG.stray);
    expect(beta).not.toContain(ACCESS_SLUG.claude);
    expect(markerOn(betaHtml, betaPane)).toBe("1");
  });

  it(`§6 · an Agents row is the agent slug in mono over its description, then "allowed" with one mono badge per allow entry (or —) and "ask first" with one warning badge per approval entry (or —), then "reaches R of T tools · K ask first[ · P of PT prompts][ · Q of QT resources] · C calls · 7 d" with C the tools/call rows audit_query reports for that principal on this app in seven days — and NO right-hand control; after the rows the note "Granting a new agent starts from the agent's own page — Agents → the agent → Grant another app." linking /agents (the twin)`, async () => {
    const pane = paths.appPane(ALPHA, "access");
    const html = await page(pane, access.cookie);
    const rows = Object.fromEntries(
      (["claude", "pi"] as const).map((handle) => [
        handle,
        textOf(rowMarkupFor(html, `agent:${ACCESS_SLUG[handle]}`)),
      ]),
    );
    for (const handle of ["claude", "pi"] as const) {
      expect(ACCESS_NAME[handle], "the fixture's name must differ from its slug").not.toBe(
        ACCESS_SLUG[handle],
      );
      expect(rows[handle], handle).toContain(ACCESS_SLUG[handle]);
      expect(rows[handle], handle).toContain(ACCESS_DESCRIPTION[handle]);
      expect(rows[handle], handle).toContain("allowed");
      expect(rows[handle], handle).toContain("ask first");
      expect(rows[handle], handle).toContain("calls · 7 d");
    }
    // The agent that only ALLOWS has no ask entry, and the one that only asks no allow.
    expect(rows.claude).toContain("all");
    expect(rows.pi).toContain("reader");
    expect(rows.claude).toContain("—");
    expect(rows.pi).toContain("—");

    // No right-hand control: the row is a link into the details, and nothing else.
    expect(formsRenderedOn(rowMarkupFor(html, `agent:${ACCESS_SLUG.claude}`))).toEqual([]);
    // THE TWIN: the note under the rows sends a NEW grant to the agent's own page.
    expect(textOf(html)).toContain(AGENTS_NOTE);
    expect(links(html, paths.agents)).toBe(true);
  });

  it(`§6 · the Agents details with nothing selected is "Select an agent to edit what it may call on <slug>." over the card "Per tool": the first six tools, each with the agents reaching it as "<agent>[ (ask)]" comma-joined or "no agent", then "… N more in the Catalog" with N the remainder (the twin: an app of six tools or fewer draws no "more" line)`, async () => {
    // The shared world's proxied app has five tools, which is the "six or fewer" twin.
    const few = textOf(await appPage(paths.appPane(CATALOG, "access")));
    expect(few).toContain(agentsPrompt(CATALOG));
    expect(few).toContain("Per tool");
    expect(few).toContain("paper_fetch");
    expect(few).toContain("reader-agent");
    expect(few).toContain(NO_AGENT);
    expect(few, "five tools need no “more” line").not.toContain("more in the Catalog");

    // …and an app of more than six, whose card stops at six and counts the rest.
    const slug = uniqueSlug("pertool");
    const tools = Array.from({ length: 9 }, (_, index) => ({
      name: `tool_${index}`,
      description: "One.",
      inputSchema: { type: "object" },
    }));
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools });
    try {
      const many = textOf(await appPage(paths.appPane(slug, "access")));
      expect(many).toContain("… 3 more in the Catalog");
      expect(many).toContain("tool_5");
      expect(many).not.toContain("tool_6");
    } finally {
      await close();
    }
  });

  it(`§6 · a selected agent draws the header — the slug in mono, an "agent" badge, the description and an open agent page link to /agents/<agent>/apps/<slug> — over "<agent>'s grant on <slug>. Solid: set on the row · hollow: implied by a role · a row cannot lower what a role grants."`, async () => {
    const html = await page(
      `${paths.appPane(ALPHA, "access")}?sel=agent:${ACCESS_SLUG.claude}`,
      access.cookie,
    );
    const text = textOf(html);
    expect(text).toContain(ACCESS_SLUG.claude);
    expect(text).toContain("agent");
    expect(text).toContain(ACCESS_DESCRIPTION.claude);
    expect(links(html, paths.agentApp(ACCESS_SLUG.claude, ALPHA))).toBe(true);
    expect(text).toContain(grantLegend(ACCESS_SLUG.claude, ALPHA));
  });

  it(`§6 · the editor IS the agent page's, verbatim: the reach summary line, the groups Roles, Tools · N, Prompts · N, Resources · N and Patterns · N, the same rows, the same none · ask · allow radios named e.<entry> with the same checked, hollow-implied and disabled-below states and the same drop and carry fields — one shared renderer, asserted by the two pages drawing the SAME control set for the same pair — and no pattern offer here, the details carrying no filter (the twin: the agent page's own pane)`, async () => {
    const onApp = await appPage(`${paths.appPane(CATALOG, "access")}?sel=agent:mixed-agent`);
    const onAgent = await appPage(paths.agentApp("mixed-agent", CATALOG));

    // The SAME control set: every `e.<entry>` radio group, its values and its states.
    const entries = (html: string): string[] =>
      [...new Set(
        [...html.matchAll(/<input\b([^>]*)>/g)]
          .filter((control) => attributeOf(control[1], "type") === "radio")
          .map((control) => decodeEntities(attributeOf(control[1], "name") ?? "")),
      )].sort();
    expect(entries(onApp).length, "the editor drew no row at all").toBeGreaterThan(0);
    expect(entries(onApp)).toEqual(entries(onAgent));
    for (const name of entries(onApp)) {
      const entry = name.slice("e.".length);
      expect(segOf(onApp, entry), entry).toEqual(segOf(onAgent, entry));
    }
    // The groups the agent page draws, drawn here too.
    const text = textOf(onApp);
    for (const group of ["Roles", "Tools ·", "Prompts ·", "Resources ·"]) {
      expect(text, group).toContain(group);
    }
    // No pattern offer here: the details carry no filter, so there is no `q` to offer.
    expect(getFormsOn(onApp)).toEqual([]);
    expect(dropOffers(onApp).length).toBeGreaterThanOrEqual(0);
  });

  it(`§6/§8 · Save on the app page's Agents pane composes the same grant_set the agent page's route composes and lands 303 on /apps/<slug>/access?sel=agent:<agent> with the notice · the same submission made on the agent page lands on the agent page (the twin), and both leave the pair's saved set identical`, async () => {
    const agent = await grantRole(CATALOG, "twinagent", "reader", "allow");
    const pane = paths.appPane(CATALOG, "access");
    const href = `${pane}?sel=agent:${agent}`;
    const html = await appPage(href);
    const target = actionFor(html, "grant_set");
    const fields = paneSubmission(html, target);
    expect(fields.agent).toBe(agent);

    const posted = await formPost(target, { ...fields, "e.tool/paper_fetch": "approval" }, detail.session.cookie);
    expect(posted.status).toBe(303);
    expect(new URL(posted.headers.get("Location") ?? "", ORIGIN).pathname).toBe(pane);
    expect(new URL(posted.headers.get("Location") ?? "", ORIGIN).searchParams.get("sel")).toBe(
      `agent:${agent}`,
    );
    const fromApp = await grantsOn(detail.ns.owner.userId, agent, CATALOG);

    // THE TWIN: the same choice made on the AGENT page lands there and saves the same set.
    const other = await grantRole(CATALOG, "twinagenttwo", "reader", "allow");
    const agentHref = paths.agentApp(other, CATALOG);
    const agentHtml = await appPage(agentHref);
    const agentTarget = actionFor(agentHtml, "grant_set");
    const landed = await formPost(
      agentTarget,
      { ...paneSubmission(agentHtml, agentTarget), "e.tool/paper_fetch": "approval" },
      detail.session.cookie,
    );
    expect(landed.status).toBe(303);
    expect(new URL(landed.headers.get("Location") ?? "", ORIGIN).pathname).toBe(agentHref);
    expect(await grantsOn(detail.ns.owner.userId, other, CATALOG)).toEqual(fromApp);
  });

  it(`§6/§9 · a refused grant_set from the app page redraws the pane at 400 with the reason above the editor and every submitted choice preserved, never a bare error page and never a partial write`, async () => {
    const agent = await grantRole(CATALOG, "refusedagent", "reader", "allow");
    const href = `${paths.appPane(CATALOG, "access")}?sel=agent:${agent}`;
    const html = await appPage(href);
    const target = actionFor(html, "grant_set");
    const before = await grantsOn(detail.ns.owner.userId, agent, CATALOG);

    // A proxied app refuses a role it does not declare (§8) — the cheapest real refusal.
    const refused = await formPost(
      target,
      { ...paneSubmission(html, target), add: "nosuchrole", mode: "allow" },
      detail.session.cookie,
    );
    expect(refused.status).toBe(400);
    const body = await refused.text();
    // The PANE is redrawn: the listing is still there, and so is the editor's own row.
    expect(textOf(body)).toContain(AGENTS_SUB);
    expect(checkedIn(body, "reader")).toBe("allow");
    // …and nothing was written.
    expect(await grantsOn(detail.ns.owner.userId, agent, CATALOG)).toEqual(before);
  });

  it(`§6 · Remove <agent> opens ?confirm=remove-agent&agent=<slug> on THIS pane — the dialog "Remove <agent> from <slug>?" over "<agent> loses every entry on <slug>. History stays; a waiting request expires." — whose form posts clear=1 to grant_set, after which the agent is off the pane and off the rail's Agents marker · the same query on another pane's URL draws no dialog (the twin)`, async () => {
    const agent = await grantRole(CATALOG, "removedagent", "reader", "allow");
    const pane = paths.appPane(CATALOG, "access");
    const before = markerOn(await appPage(pane), pane);
    const html = await appPage(`${pane}?sel=agent:${agent}`);
    const confirm = confirmLinksOn(html).find((href) => href.includes("remove-agent")) ?? "";
    expect(new URL(confirm, ORIGIN).pathname).toBe(pane);
    expect(new URL(confirm, ORIGIN).searchParams.get("agent")).toBe(agent);

    const dialog = await appPage(confirm);
    expect(textOf(dialog)).toContain(`Remove ${agent} from ${CATALOG}?`);
    expect(textOf(dialog)).toContain(removeAgentBody(agent, CATALOG));
    const target = actionFor(dialog, "grant_set");
    const posted = await formPost(target, submissionOf(dialog), detail.session.cookie);
    expect(posted.status).toBe(303);

    const after = await appPage(pane);
    expect(textOf(after)).not.toContain(agent);
    expect(Number(markerOn(after, pane))).toBe(Number(before) - 1);
    // THE TWIN: the same query on another pane's URL draws no dialog at all.
    const elsewhere = paths.appPane(CATALOG, "roles");
    const carried = `${elsewhere}${new URL(confirm, ORIGIN).search}`;
    expect(opsOn(await appPage(carried))).toEqual(opsOn(await appPage(elsewhere)));
  });
});

/* ------------------------------------------------------------------ *
 * /apps/<slug> — the Access group, the Danger zone, and the refusals
 * ------------------------------------------------------------------ */

/** §13's pinned sentences for the three panes below, each byte-identical with the spec
 *  (the backticked ones go through `pinned`; none of these carries a code span). */
const PROXIED_NO_TOKENS = "Proxied apps hold no tokens — the hub dials the upstream; nothing dials in.";
const REVOKE_CLOSES = "Revoking closes the app's live connection.";
/** …and the body for a key no socket is holding, which is the other half of §7's rule. */
const REVOKE_OFFLINE = "The app can no longer connect with it.";
const ISSUE_ROTATION = "The previous token keeps working until you revoke it.";
const ARCHIVE_SENTENCE = "It refuses connections and leaves the list — tokens, grants and history are kept.";
const deleteSentence = (tokens: number, agents: number): string =>
  `Revokes its ${tokens} token${tokens === 1 ? "" : "s"}, closes the live connection and removes ` +
  `every grant (${agents} agent${agents === 1 ? "" : "s"}). This cannot be undone.`;
const ARCHIVED_BANNER =
  "Archived apps refuse connections; everything is kept — tokens, grants and audit history.";

/** The Agents-pane fixture: two proxied apps and three agents, so "exactly the agents
 *  holding a grant on THIS app" has something to exclude and something to include. */
const ALPHA = uniqueSlug("alpha");
const BETA = uniqueSlug("beta");
const ACCESS_SLUG = { claude: uniqueSlug("claude"), pi: uniqueSlug("pi"), stray: uniqueSlug("stray") };
/** Names DIFFER from slugs, so "the row renders the slug" cannot be satisfied by the name. */
const ACCESS_NAME = { claude: "Main assistant", pi: "Home Pi", stray: "Passing bot" };
const ACCESS_DESCRIPTION = { claude: "the main agent", pi: "the home Raspberry Pi", stray: "granted next door" };
const accessScenario: UpstreamScenario = { id: uniqueSlug("accessup"), mode: { kind: "ok" } };

let access: { ns: SeededNamespace; cookie: string; ownerId: string };

/** Its own namespace and its own sign-in: `page` defaults to the file world's cookie, a
 *  different owner, and asserts 200 — an omitted cookie would fail as a login bounce
 *  rather than as the property under test. */
async function seedAccessWorld(): Promise<typeof access> {
  const ns = await seedNamespace(env.DB, {
    apps: [ALPHA, BETA].map((slug) => ({
      slug,
      kind: "proxy" as const,
      upstreamUrl: upstreamUrlFor(accessScenario),
      upstreamAuthMode: "headers" as const,
      // Declared roles on a tunneled app exist only after a real registration, and nothing
      // in these rows is kind-dependent.
      roles: { reader: ["get_.*"] },
    })),
    agents: [
      {
        slug: ACCESS_SLUG.claude,
        name: ACCESS_NAME.claude,
        description: ACCESS_DESCRIPTION.claude,
        grants: { [ALPHA]: [{ role: "all", mode: "allow" }] },
      },
      {
        slug: ACCESS_SLUG.pi,
        name: ACCESS_NAME.pi,
        description: ACCESS_DESCRIPTION.pi,
        grants: { [ALPHA]: [{ role: "reader", mode: "approval" }] },
      },
      {
        slug: ACCESS_SLUG.stray,
        name: ACCESS_NAME.stray,
        description: ACCESS_DESCRIPTION.stray,
        grants: { [BETA]: [{ role: "reader", mode: "allow" }] },
      },
    ],
  });
  return { ns, cookie: (await seedOwnerSession(ns.owner)).cookie, ownerId: ns.owner.userId };
}

/** One tunneled app of this section's own, with its own owner and sign-in — the shape
 *  nearly every row below needs, so no row inherits another's keys or grants. */
async function seedTunneledApp(
  slug: string,
  spec: { tokens?: TokenSpec[]; agent?: string } = {},
): Promise<{ ns: SeededNamespace; cookie: string; ownerId: string }> {
  const ns = await seedNamespace(env.DB, {
    apps: [{ slug, kind: "tunnel", tokens: spec.tokens }],
    agents:
      spec.agent === undefined
        ? []
        : [{ slug: spec.agent, grants: { [slug]: [{ role: "all", mode: "allow" }] } }],
  });
  return { ns, cookie: (await seedOwnerSession(ns.owner)).cookie, ownerId: ns.owner.userId };
}

/** One app token presented at the door, which is where "stops authenticating a tunnel" is
 *  observable in-process: identity's own resolver, not a page's claim about it. */
function dialsIn(token: string): Promise<{ appId: string; tokenId: string } | null> {
  return resolveAppToken(new Request(`${ORIGIN}/connect`, { headers: { Authorization: `Bearer ${token}` } }));
}

describe(`§7 · /apps/<slug> — Token, Overview and the Danger zone`, () => {

  it(`§7 · the Token listing header is the title Token over "what the app presents to dial in", the Issue new token button at the right edge, and the summary "L live · app tokens have no expiry — rotate by issuing, then revoking the old one. Revoking the key a live socket used closes it." — a row being the prefix in mono with "holds the live socket" as a success badge where it does and "new" where it was just issued, over "issued <relative> · used <relative> | never used" and a Revoke reaching ?confirm=revoke-token&id= · an app with no live key reads "No live token — the app cannot connect until one is issued." (the twin)`, async () => {
    const slug = uniqueSlug("tokhead");
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "live" }] });
    const key = (await tokensOf(world_.ownerId)).find((token) => token.refSlug === slug);
    if (key === undefined) throw new Error("the seeded key vanished");
    const pane = paths.appPane(slug, "token");
    const html = await page(pane, world_.cookie);
    const text = textOf(html);
    expect(text).toContain("Token");
    expect(text).toContain(TOKEN_SUB);
    expect(text).toContain(`1 live · ${TOKEN_ROTATION}`);
    expect(text).toContain(key.prefix);
    expect(text).toContain("never used");
    expect(links(html, paths.appConfirm(slug, "token", "revoke-token", key.id))).toBe(true);
    expect(formsRenderedOn(html).map((form) => form.op)).toContain("token_issue");

    // THE TWIN: an app with no live key says so rather than drawing an empty list.
    const empty = uniqueSlug("tokempty");
    const bare = await seedTunneledApp(empty, {});
    expect(textOf(await page(paths.appPane(empty, "token"), bare.cookie))).toContain(NO_LIVE_TOKEN);
  });

  it(`§7 · a just-issued token is SELECTED and its reveal is drawn in the details — "Shown once — copy it now", the key, "The previous token keeps working until you revoke it." — over Issued, "Expires → never — revoke on compromise", Last used and "Connection → holds the live socket now | none", beneath the prefix, an "app token" badge and "Only valid for opening the reverse WebSocket as <slug>." · the same pane re-fetched carries no plaintext anywhere (the twin)`, async () => {
    const slug = uniqueSlug("tokreveal");
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "seeded" }] });
    const pane = paths.appPane(slug, "token");
    const listed = await page(pane, world_.cookie);
    const target = actionFor(listed, "token_issue");

    const posted = await formPost(target, formsPostingTo(listed, target)[0], world_.cookie);
    expect(posted.status).toBe(200);
    const body = await posted.text();
    const revealed = TOKEN_MATERIAL.exec(body)?.[0] ?? "";
    expect(revealed.startsWith("pmcp_app_")).toBe(true);
    const text = textOf(body);
    expect(text).toContain(REVEAL_ONCE);
    expect(text).toContain(ISSUE_ROTATION);
    expect(text).toContain("app token");
    expect(text).toContain(tokenScope(slug));
    expect(text).toContain(EXPIRES_NEVER);
    // The new row is the SELECTED one, which is what puts the reveal in the details.
    const minted = (await tokensOf(world_.ownerId)).find(
      (token) => token.refSlug === slug && token.id !== world_.ns.tokens.seeded.id,
    );
    if (minted === undefined) throw new Error("token_list reports no new key");
    expect(text).toContain("new");
    expect(body).toContain(minted.prefix);

    // THE TWIN: the plaintext exists in that one response only.
    const again = await page(pane, world_.cookie);
    expect(again).not.toContain(revealed);
    expect(again).not.toMatch(TOKEN_MATERIAL);
  });

  it(`§7 · the Overview pane is WIDE and is app_get's own row as a definition list — Slug, Kind, Created, a proxied app's Endpoint / Auth / Forward identity, a tunneled app's Last seen, Body logging reading "On — tunneled default" / "Off — proxied default" at each kind's default and the bare word where the owner set it explicitly, and Description — read-only: the pane renders no mutating form of any kind, the Body logging line included, the switch living on Recording (the twin)`, async () => {
    const proxied = await appPage(paths.appPane(CATALOG, "overview"));
    const row = await appRowOf(CATALOG);
    const text = textOf(proxied);
    expect(proxied).toContain("listing--wide");
    expect(text).toContain(CATALOG);
    expect(text).toContain(row.kind);
    expect(text).toContain(row.endpoint ?? "");
    expect(text).toContain("Forward identity");
    expect(text).toContain(LOG_BODIES_PROXY);
    // Read-only: no form, so the switch is Recording's and Recording's alone.
    expect(opsOn(proxied)).toEqual([]);
    expect(checkboxesOn(proxied)).toEqual({});

    // The tunneled default, and the explicit setting that replaces both sentences.
    const tunneled = textOf(await appPage(paths.appPane(TUNNELAPP, "overview")));
    expect(tunneled).toContain(LOG_BODIES_TUNNEL);
    const explicit = await seedRecordingApp("overexplicit", { logBodies: false });
    const set = textOf(await appPage(paths.appPane(explicit.slug, "overview")));
    expect(set).not.toContain(LOG_BODIES_TUNNEL);
    expect(set).not.toContain(LOG_BODIES_PROXY);
    expect(set).toMatch(/Body logging Off\b/);
  });

  it(`§10 · the long-data fixtures render whole rather than truncating a listing away: a 300-character pattern on a role, a 40-word tool description and a 60-character slug each appear in full in their own pane's row and in its details, and the pane still draws every other row beside them (the twin)`, async () => {
    // 120, not the brief's 300: §20.3 caps a pattern at 128 characters, and a fixture the
    // op refuses would pin nothing about how the page draws a long one.
    const long = "get_".concat("x".repeat(116));
    expect(long.length).toBe(120);
    const app = await seedRoleApp("longdata", {
      owner: { longrole: { tools: [long] }, shortrole: { tools: ["get_paper"] } },
    });
    const pane = paths.appPane(app.slug, "roles");
    const listing = await page(pane, detail.session.cookie);
    // The pattern is on the row whole, and the row beside it is still drawn — the twin.
    expect(textOf(rowMarkupFor(listing, "role:longrole"))).toContain(long);
    expect(selValuesOn(listing, pane)).toContain("role:shortrole");

    // …and whole again in the details, beside every other pattern row.
    const details = await page(`${pane}?sel=role:longrole`, detail.session.cookie);
    expect(textOf(details)).toContain(long);
    expect(valuesNamed("drop", details)).toEqual([`tools/${long}`]);
  });
  beforeAll(withAppDetailWorld);
  beforeAll(async () => {
    access = await seedAccessWorld();
  });



  it(`§13 · /apps/<slug>/token lists a tunneled app's live tokens by display prefix and the rail marker is that live count · the same app's revoked and expired tokens are absent from the pane though token_list still reports all three (the twin), and no plaintext appears anywhere on it`, async () => {
    const slug = uniqueSlug("feedlist");
    const world_ = await seedTunneledApp(slug, {
      // All three rows are production-shaped: revoked through revokeToken, expired against
      // a backdated clock (harness/seed's own note).
      tokens: [{ as: "live" }, { as: "dead", revoked: true }, { as: "stale", expired: true }],
    });
    const reported = (await tokensOf(world_.ownerId)).filter((token) => token.refSlug === slug);
    expect(reported.length, "token_list still reports all three").toBe(3);
    const live = reported.filter(
      (token) => token.revokedAt === null && (token.expiresAt === null || token.expiresAt > Date.now()),
    );
    expect(live.length).toBe(1);

    const pane = paths.appPane(slug, "token");
    const html = await page(pane, world_.cookie);
    expect(html).toContain(live[0].prefix);
    for (const gone of reported.filter((token) => token.id !== live[0].id)) {
      expect(html, gone.id).not.toContain(gone.prefix);
    }
    expect(markerOn(html, pane)).toBe("1");

    // §5 hygiene: no plaintext, and nothing token-shaped — the display prefix is twelve
    // characters, far short of what `tokenPattern(16)` asks for.
    for (const handle of ["live", "dead", "stale"]) expect(html).not.toContain(world_.ns.tokens[handle].token);
    expect(html).not.toMatch(TOKEN_MATERIAL);
  });

  it(`§7 · Revoke on /apps/<slug>/token walks end to end as a browser walks it — the confirm link, the dialog whose body is "The app can no longer connect with it." for a key holding no socket and "Revoking closes the app's live connection." for the key that holds one, the posted form, the redirect back to the token pane — and the key stops authenticating a tunnel while the app's other live key still does (the twin)`, async () => {
    const slug = uniqueSlug("feedrev");
    // Two LIVE keys, so the revoke is a revoke OF one rather than an emptying.
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "doomed" }, { as: "keeper" }] });
    const rows = (await tokensOf(world_.ownerId)).filter((token) => token.refSlug === slug);
    const doomed = rows.find((token) => token.id === world_.ns.tokens.doomed.id);
    const keeper = rows.find((token) => token.id === world_.ns.tokens.keeper.id);
    if (doomed === undefined || keeper === undefined) throw new Error("the seeded keys vanished");

    const pane = paths.appPane(slug, "token");
    const listed = await page(pane, world_.cookie);
    const confirm = paths.appConfirm(slug, "token", "revoke-token", doomed.id);
    expect(links(listed, confirm)).toBe(true);
    // A confirm naming a token id no row carries draws no dialog at all.
    const guessed = paths.appConfirm(slug, "token", "revoke-token", uniqueSlug("nope"));
    expect(formsOn(await page(guessed, world_.cookie))).toEqual(formsOn(listed));

    const dialog = await page(confirm, world_.cookie);
    // Neither key holds a socket, so this is the OTHER body — the live one is below.
    expect(textOf(dialog)).toContain(REVOKE_OFFLINE);
    expect(textOf(dialog)).not.toContain(REVOKE_CLOSES);
    expect(dialog).toContain(doomed.prefix);
    const target = actionFor(dialog, "token_revoke");
    expect(new URL(target, ORIGIN).searchParams.get("id")).toBe(doomed.id);
    const posted = await formPost(target, submissionOf(dialog), world_.cookie);
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe(`${pane}?done=token_revoke`);

    const after = await page(pane, world_.cookie);
    expect(after).not.toContain(doomed.prefix);
    expect(after).toContain(keeper.prefix);
    expect(markerOn(after, pane)).toBe("1");

    // At the door, which is where "closes the app's live connection" is observable in
    // process — the twin is what keeps a resolver that always says no from passing.
    expect(await dialsIn(world_.ns.tokens.doomed.token)).toBeNull();
    expect(await dialsIn(world_.ns.tokens.keeper.token)).toMatchObject({ appId: world_.ns.apps[slug].id });

    // The OTHER body, on a key that does hold the socket — which is the whole difference.
    const live = uniqueSlug("feedlive");
    const closeSocket = await dialTunnel(live, { capabilities: ["tools"], tools: PLAIN_TOOLS });
    try {
      const held = (await tokensOf(detail.ns.owner.userId)).find((token) => token.refSlug === live);
      if (held === undefined) throw new Error("the dialled key vanished");
      const open = await appPage(paths.appConfirm(live, "token", "revoke-token", held.id));
      expect(textOf(open)).toContain(REVOKE_CLOSES);
    } finally {
      await closeSocket();
    }
  });

  it(`§13 · Issue new token fronts token_issue { kind: "app" } from the token pane's own target — not the generic 303 dispatch — and renders the once-only reveal in place with "The previous token keeps working until you revoke it.", after which both keys authenticate a tunnel and the pane's marker reads 2 (§5: more than one live app token is legal)`, async () => {
    const slug = uniqueSlug("feedissue");
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "seeded" }] });
    const pane = paths.appPane(slug, "token");
    const listed = await page(pane, world_.cookie);

    // The op's own field names on the target's query string, parsed off the action rather
    // than spelled here.
    const target = actionFor(listed, "token_issue");
    const named = new URL(target, ORIGIN).searchParams;
    expect(named.get("kind")).toBe("app");
    expect(named.get("slug")).toBe(slug);

    // 200, not 303: the reveal cannot survive a redirect and `dispatch` unconditionally
    // redirects, so this is a route of its own (§15 — a plaintext key never rides a URL).
    const posted = await formPost(target, formsPostingTo(listed, target)[0], world_.cookie);
    expect(posted.status).toBe(200);
    const body = await posted.text();
    const revealed = TOKEN_MATERIAL.exec(body)?.[0] ?? "";
    expect(revealed.startsWith("pmcp_app_")).toBe(true);
    expect(revealed).not.toBe(world_.ns.tokens.seeded.token);
    expect(textOf(body)).toContain(ISSUE_ROTATION);

    // Rotation is issue-then-revoke, in that order: a hub that revoked on issue fails here.
    const appId = world_.ns.apps[slug].id;
    expect(await dialsIn(revealed)).toMatchObject({ appId });
    expect(await dialsIn(world_.ns.tokens.seeded.token)).toMatchObject({ appId });

    const after = await page(pane, world_.cookie);
    expect(markerOn(after, pane)).toBe("2");
    const live = (await tokensOf(world_.ownerId)).filter(
      (token) => token.refSlug === slug && token.revokedAt === null,
    );
    expect(live.length, "the marker is the list's length, not a counter of its own").toBe(2);
    for (const token of live) expect(after).toContain(token.prefix);
    expect(after, "the plaintext exists in one response only").not.toContain(revealed);
  });

  it(`§13 · a proxied app's Token rail entry is the dimmed —, its pane says "Proxied apps hold no tokens — the hub dials the upstream; nothing dials in (§2)." and it renders no issue control — which token_issue agrees with by refusing kind: "app" on that app · a tunneled app's pane renders one (the twin)`, async () => {
    const proxied = uniqueSlug("notiontok");
    const tunneled = uniqueSlug("feedtok");
    const scenario: UpstreamScenario = { id: uniqueSlug("tokup"), mode: { kind: "ok" } };
    // ONE namespace holding both kinds, so the two legs differ in exactly one thing.
    const ns = await seedNamespace(env.DB, {
      apps: [
        {
          slug: proxied,
          kind: "proxy",
          upstreamUrl: upstreamUrlFor(scenario),
          upstreamAuthMode: "headers",
        },
        { slug: tunneled, kind: "tunnel", tokens: [{ as: "live" }] },
      ],
    });
    const { cookie } = await seedOwnerSession(ns.owner);

    const proxiedPane = paths.appPane(proxied, "token");
    const dimmed = await page(proxiedPane, cookie);
    expect(markerOn(dimmed, proxiedPane)).toBe(DIMMED_MARKER);
    expect(textOf(dimmed)).toContain(PROXIED_NO_TOKENS);
    const drawn = formsRenderedOn(dimmed).map((form) => form.op);
    expect(drawn).not.toContain("token_issue");
    expect(drawn).not.toContain("token_revoke");
    // The absence is not the page hiding a working capability: the op refuses the same
    // thing (§8 — `kind: "app"` is rejected for proxied apps).
    await expect(ops.token_issue.handler(ns.owner.userId, { kind: "app", slug: proxied })).rejects.toThrow();
    // And the refusal left NO row behind: a handler that minted the key and then threw is
    // invisible to the pane, whose marker is derived from the app's kind, not from a list.
    expect((await tokensOf(ns.owner.userId)).filter((token) => token.refSlug === proxied)).toEqual([]);

    const tunneledPane = paths.appPane(tunneled, "token");
    const live = await page(tunneledPane, cookie);
    expect(formsRenderedOn(live).map((form) => form.op)).toContain("token_issue");
    expect(markerOn(live, tunneledPane)).toMatch(/^\d+$/);
  });

  it(`§13 · Archive on /apps/<slug>/danger walks end to end behind its dialog — "It refuses connections and leaves the list — tokens, grants and history are kept." — and afterwards the page still renders under the verbatim archived banner with its tokens and grants still listed and its header status reading archived, until Unarchive (posted as the browser posts it) takes the banner away again · the same page carried no banner before (the twin), and the Danger rail entry is an ordinary link carrying no marker`, async () => {
    const slug = uniqueSlug("feedarch");
    const agent = uniqueSlug("archagent");
    // Something to retain, or "tokens, grants and history are kept" is vacuous.
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "live" }], agent });
    const key = (await tokensOf(world_.ownerId)).find((token) => token.refSlug === slug);
    if (key === undefined) throw new Error("the seeded key vanished");
    const tokenPane = paths.appPane(slug, "token");
    const accessPane = paths.appPane(slug, "access");
    const dangerPane = paths.appPane(slug, "danger");

    // BEFORE, the twin — no banner, and both retained things listed.
    expect(textOf(await page(paths.appDetail(slug), world_.cookie))).not.toContain(ARCHIVED_BANNER);
    expect(await page(tokenPane, world_.cookie)).toContain(key.prefix);
    expect(textOf(await page(accessPane, world_.cookie))).toContain(agent);

    // The Danger rail entry is neutral as STRUCTURE, which is all §7 leaves assertable:
    // an ordinary anchor built from `paths`, carrying no marker. Colour is incidental.
    const danger = await page(dangerPane, world_.cookie);
    expect(links(danger, dangerPane)).toBe(true);
    expect(markerOn(danger, dangerPane)).toBe("");

    const confirm = paths.appConfirm(slug, "danger", "archive");
    expect(links(danger, confirm)).toBe(true);
    const dialog = await page(confirm, world_.cookie);
    expect(textOf(dialog)).toContain(ARCHIVE_SENTENCE);
    const posted = await formPost(actionFor(dialog, "app_archive"), submissionOf(dialog), world_.cookie);
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe(`${dangerPane}?done=app_archive`);

    // AFTER: §13's "an archived app's page stays reachable", with everything still on it.
    const landing = await get(paths.appDetail(slug), world_.cookie);
    expect(landing.status).toBe(200);
    const banner = textOf(await landing.text());
    expect(banner).toContain(ARCHIVED_BANNER);
    expect(banner).toContain("archived");
    expect(await page(tokenPane, world_.cookie)).toContain(key.prefix);
    expect(textOf(await page(accessPane, world_.cookie))).toContain(agent);

    // §9 rule 4b: the form this row rendered is posted the way a browser posts it.
    const archived = await page(dangerPane, world_.cookie);
    const unarchive = actionFor(archived, "app_unarchive");
    const back = await formPost(unarchive, formsPostingTo(archived, unarchive)[0], world_.cookie);
    expect(back.status).toBe(303);
    expect(back.headers.get("Location")).toBe(`${dangerPane}?done=app_unarchive`);
    expect(textOf(await page(paths.appDetail(slug), world_.cookie))).not.toContain(ARCHIVED_BANNER);
    const listedApps = (await ops.app_list.handler(world_.ownerId, {})) as {
      apps: { slug: string; archived: boolean }[];
    };
    expect(listedApps.apps.find((row) => row.slug === slug)?.archived).toBe(false);
  });

  it(`§13 · Delete on /apps/<slug>/danger walks end to end behind its dialog — "Revokes its tokens, closes the live connection and removes every grant. This cannot be undone." — and afterwards the app's page is byte-identical to an unknown slug's 404 · a sibling app's page still renders (the twin)`, async () => {
    const doomed = uniqueSlug("doomed");
    const keeper = uniqueSlug("keeper");
    const agent = uniqueSlug("delagent");
    const ns = await seedNamespace(env.DB, {
      apps: [
        { slug: doomed, kind: "tunnel", tokens: [{ as: "doomed" }] },
        { slug: keeper, kind: "tunnel" },
      ],
      agents: [{ slug: agent, grants: { [doomed]: [{ role: "all", mode: "allow" }] } }],
    });
    const { cookie } = await seedOwnerSession(ns.owner);

    const dangerPane = paths.appPane(doomed, "danger");
    const confirm = paths.appConfirm(doomed, "danger", "delete");
    expect(links(await page(dangerPane, cookie), confirm)).toBe(true);
    const dialog = await page(confirm, cookie);
    expect(textOf(dialog)).toContain(deleteSentence(1, 1));
    expect(textOf(dialog)).toContain(doomed);

    const posted = await formPost(actionFor(dialog, "app_delete"), submissionOf(dialog), cookie);
    expect(posted.status).toBe(303);
    // WHERE it lands is not pinned — §13 pins only that the deleted page is a 404 — but the
    // owner is not left on a dead page.
    const landed = posted.headers.get("Location") ?? "";
    expect(landed.startsWith(paths.appDetail(doomed))).toBe(false);
    expect((await get(landed, cookie)).status).toBe(200);

    // The one-answer property row 8 pins for /approvals/<id>, here for /apps/<slug>.
    const gone = await get(paths.appDetail(doomed), cookie);
    const never = await get(paths.appDetail(uniqueSlug("never")), cookie);
    expect(gone.status).toBe(404);
    expect({ status: gone.status, text: await gone.text() }).toEqual({
      status: never.status,
      text: await never.text(),
    });

    // The twin, and the op's cascade (§8).
    expect(await page(paths.appDetail(keeper), cookie)).toContain(keeper);
    const listedApps = (await ops.app_list.handler(ns.owner.userId, {})) as { apps: { slug: string }[] };
    expect(listedApps.apps.map((row) => row.slug)).not.toContain(doomed);
    expect((await tokensOf(ns.owner.userId)).filter((token) => token.refSlug === doomed)).toEqual([]);
  });

  it(`§13 · every /apps row links to its detail page, the archived section included, while the builtin pmcp row links to none — and the list's own Archive / Unarchive / Delete / Connect actions are still rendered beside the link (the twin)`, async () => {
    // Read through the op rather than through assumptions about which earlier case ran.
    const listed = (await ops.app_list.handler(world.ns.owner.userId, {})) as {
      apps: { slug: string; kind: string; archived: boolean }[];
    };
    const builtin = listed.apps.filter((row) => row.kind === "builtin");
    const archived = listed.apps.filter((row) => row.kind !== "builtin" && row.archived);
    const active = listed.apps.filter((row) => row.kind !== "builtin" && !row.archived);
    expect(builtin.map((row) => row.slug)).toContain(PMCP_SLUG);
    expect(archived.length, "the archived section must not be empty").toBeGreaterThan(0);
    expect(active.length).toBeGreaterThan(0);

    const html = await page(paths.apps);
    for (const row of [...active, ...archived]) {
      expect(links(html, paths.appDetail(row.slug)), row.slug).toBe(true);
    }
    // A link on the builtin row would be a link to the 404 the refusals row pins.
    expect(links(html, paths.appDetail(PMCP_SLUG))).toBe(false);

    // The twin: a detail link that had REPLACED the row's own actions fails here.
    const drawn = new Set(formsRenderedOn(html).map((form) => form.op));
    // Per SECTION, not one disjunction over the page: apps.tsx draws Unarchive on an
    // archived row and Archive on an active one, and both sections are non-empty above, so
    // an OR would stay green with either section's own action gone.
    expect(drawn.has("app_archive"), "the active section's own action").toBe(true);
    expect(drawn.has("app_unarchive"), "the archived section's own action").toBe(true);
    expect(drawn.has("connect") || drawn.has("app_disconnect")).toBe(true);
    expect(
      [...active, ...archived].some((row) => links(html, paths.appsConfirmDelete(row.slug))),
    ).toBe(true);
  });

  it(`§13 · every /apps row IS the link — the name an anchor class="row-link" stretched over a class="app-row" row with the trailing chevron, on the active and the archived rows alike (2026-09-16: as the agents list, replacing the name-only link) — while the row's own Archive / Unarchive / Delete / Connect actions still sit beside it above the stretched anchor, and the builtin pmcp row is still not listed (the twin)`, async () => {
    const listed = (await ops.app_list.handler(world.ns.owner.userId, {})) as {
      apps: { slug: string; kind: string; archived: boolean }[];
    };
    const rows = listed.apps.filter((row) => row.kind !== "builtin");
    expect(rows.some((row) => row.archived), "the archived section must not be empty").toBe(true);
    expect(rows.some((row) => !row.archived)).toBe(true);

    const html = await page(paths.apps);
    // One `app-row` per listed app and no other, each closed by its own </tr>, so every
    // assertion below is about ONE row's markup and not the page's.
    const trs = [...html.matchAll(/<tr class="app-row">([\s\S]*?)<\/tr>/g)].map((match) => match[1]);
    expect(trs.length).toBe(rows.length);
    for (const row of rows) {
      const tr = trs.find((markup) => links(markup, paths.appDetail(row.slug)));
      expect(tr, `no app-row links ${row.slug}`).toBeDefined();
      // The stretched anchor is the NAME's, and it is the row's only link to the page.
      const stretched = [...(tr ?? "").matchAll(/<a class="row-link" href="([^"]*)"/g)].map((m) => decodeEntities(m[1]));
      expect(stretched, row.slug).toEqual([paths.appDetail(row.slug)]);
      expect(tr, row.slug).toContain('class="row-chevron"');
      // The twin: the row's own actions are still in the row, above the anchor.
      expect(links(tr ?? "", paths.appsConfirmDelete(row.slug)), `${row.slug}: Delete`).toBe(true);
      expect(formsRenderedOn(tr ?? "").map((form) => form.op), row.slug).toContain(
        row.archived ? "app_unarchive" : "app_archive",
      );
    }
    // The builtin is not a row, so it is not a link either.
    expect(links(html, paths.appDetail(PMCP_SLUG))).toBe(false);
  });

  it(`§8 · every mutating form the /apps/<slug> panes render fronts a real admin.ops key and submits within that op's schema — every required field, and no field the schema does not declare — so the page that issues and revokes app tokens joins parity direction B instead of standing outside it`, async () => {
    const tunneled = uniqueSlug("paritytun");
    const proxied = uniqueSlug("parityprx");
    const agent = uniqueSlug("parityagent");
    const scenario: UpstreamScenario = { id: uniqueSlug("parityup"), mode: { kind: "ok" } };
    const ns = await seedNamespace(env.DB, {
      apps: [
        { slug: tunneled, kind: "tunnel", tokens: [{ as: "live" }] },
        // `oauth`, not `headers`: the header's Connect and Disconnect controls — which
        // §13 draws on EVERY pane of a proxied app — exist for that mode alone, and this
        // row's subject is every mutating form the panes render.
        { slug: proxied, kind: "proxy", upstreamUrl: upstreamUrlFor(scenario), upstreamAuthMode: "oauth" },
      ],
      agents: [{ slug: agent, grants: { [tunneled]: [{ role: "all", mode: "allow" }] } }],
    });
    const { cookie } = await seedOwnerSession(ns.owner);
    const key = (await tokensOf(ns.owner.userId)).find((token) => token.refSlug === tunneled);
    if (key === undefined) throw new Error("the seeded key vanished");

    // The destructive forms live inside the dialogs, so a walk of the bare panes misses them.
    const walked = [
      ...appPaneHrefs(tunneled),
      ...appPaneHrefs(proxied),
      paths.appConfirm(tunneled, "token", "revoke-token", key.id),
      paths.appConfirm(tunneled, "danger", "archive"),
      paths.appConfirm(tunneled, "danger", "delete"),
      // The two editors that exist only under a selection — the Roles one and, once the
      // app has a holder, the grant editor the Agents pane draws in place.
      `${paths.appPane(tunneled, "roles")}?new=1`,
      `${paths.appPane(tunneled, "access")}?sel=agent:${agent}`,
    ];
    const seen = new Set<string>();
    const walkedOps = new Set<string>();
    for (const url of walked) {
      for (const form of formsRenderedOn(await page(url, cookie))) {
        walkedOps.add(form.op);
        if (BROWSER_ONLY_TARGETS.has(form.op) || COMPOSED_APP_TARGETS.has(form.op)) continue;
        if (form.op === "sign-out") continue;
        expect(Object.prototype.hasOwnProperty.call(ops, form.op), `${url} → ${form.op}`).toBe(true);
        seen.add(form.op);
        // Both sides derived off `admin.ops`: every required field, and nothing the schema
        // does not declare. Not equality — `token_issue` declares an optional `expires_in`
        // §13 pins no control for on this pane.
        for (const required of requiredKeysOf(ops[form.op])) {
          expect(form.fields, `${form.op} required`).toContain(required);
        }
        for (const submitted of form.fields) {
          expect(schemaKeysOf(ops[form.op]), `${form.op} submitted`).toContain(submitted);
        }
      }
    }
    // The composed targets are not absent: each is a real Save this walk passed over, and
    // its own describe pins the one `app_update` it composes.
    for (const composed of COMPOSED_APP_TARGETS) {
      expect(walkedOps, composed).toContain(composed);
    }
    // Non-vacuity: the walk really saw this page's five ops. `connect` is not among them —
    // it is a browser-only target (§19's redirect), and BROWSER_ONLY_TARGETS holds it.
    for (const op of ["token_issue", "token_revoke", "app_archive", "app_delete", "app_disconnect"]) {
      expect([...seen], op).toContain(op);
    }
  });


  it(`§8/§13 · Issue new token reaches the op although its route answers 200 instead of the generic redirect: the post writes exactly one admin.token_issue audit row naming the app and the id token_list then reports, and that row carries neither the revealed key nor any token material`, async () => {
    const slug = uniqueSlug("feedaudit");
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "seeded" }] });
    // REAL ops throughout: a substituted token_issue returns {}, so no reveal could render
    // and `withCountedOps` would prove less than this does.
    const before = (await query(env.DB, world_.ownerId, { event: "admin.token_issue" })).total;

    const pane = paths.appPane(slug, "token");
    const listed = await page(pane, world_.cookie);
    const target = actionFor(listed, "token_issue");
    const posted = await formPost(target, formsPostingTo(listed, target)[0], world_.cookie);
    expect(posted.status).toBe(200);
    const revealed = TOKEN_MATERIAL.exec(await posted.text())?.[0] ?? "";
    expect(revealed).not.toBe("");

    // §8's "every mutating pmcp tool writes an admin.<tool> audit row" is the whole
    // discriminator: `summarise` inside token_issue.run is that event's only writer, and a
    // Registry-side mint writes none.
    const after = await query(env.DB, world_.ownerId, { event: "admin.token_issue" });
    expect(after.total).toBe(before + 1);
    const minted = (await tokensOf(world_.ownerId)).find(
      (token) => token.refSlug === slug && token.id !== world_.ns.tokens.seeded.id,
    );
    if (minted === undefined) throw new Error("token_list reports no new key");
    const row = after.rows[0];
    // Not `detail`: that name belongs to this describe's shared app-detail world, and the
    // shadow would put a later reader of the world inside this block's dead zone.
    const serializedDetail = JSON.stringify(row.detail);
    expect(serializedDetail).toContain(slug);
    expect(serializedDetail).toContain(minted.id);
    // §15 hygiene on the one page that has a plaintext to leak.
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(revealed);
    expect(serialized).not.toMatch(TOKEN_MATERIAL);
  });

  it(`§9/§13 · every ?confirm= link the eight /apps/<slug> panes render rides the pane that drew it and draws its dialog there · the same query moved onto another pane's URL, and an id naming no row, each draw none (the twin)`, async () => {
    const slug = uniqueSlug("totality");
    const agent = uniqueSlug("totagent");
    const world_ = await seedTunneledApp(slug, { tokens: [{ as: "live" }], agent });

    // Harvest every `?confirm=` link the eight panes render, with the pane it was on.
    const harvest: { pane: string; href: string }[] = [];
    const bare = new Map<string, string>();
    for (const pane of appPaneHrefs(slug)) {
      const html = await page(pane, world_.cookie);
      bare.set(pane, html);
      for (const href of confirmLinksOn(html)) harvest.push({ pane, href });
    }
    expect(harvest.length).toBeGreaterThan(0);
    const panesDrawing = new Set(harvest.map((found) => found.pane)).size;
    expect(panesDrawing, "one pane's dialogs are not the whole page's").toBeGreaterThan(1);

    for (const { pane, href } of harvest) {
      // §13's "confirm-dialog state rides the owning pane's URL", made observable.
      expect(new URL(href, ORIGIN).pathname, href).toBe(pane);
      const withQuery = await page(href, world_.cookie);
      // A STRICT SUPERSET rather than a difference, so a pane that legitimately renders an
      // op inline AND behind a dialog cannot fail for the wrong reason.
      expect(supersets(opsOn(withQuery), opsOn(bare.get(pane) ?? "")), href).toBe(true);
    }

    // TWIN ONE: the same query on a DIFFERENT pane's URL draws nothing.
    const moved = harvest[0];
    const elsewhere = appPaneHrefs(slug).find((pane) => pane !== moved.pane) ?? "";
    const carried = `${elsewhere}${new URL(moved.href, ORIGIN).search}`;
    expect(opsOn(await page(carried, world_.cookie))).toEqual(opsOn(bare.get(elsewhere) ?? ""));

    // TWIN TWO: the same kind with an id naming no row draws nothing either.
    const guessed = paths.appConfirm(slug, "token", "revoke-token", uniqueSlug("nope"));
    const tokenPane = paths.appPane(slug, "token");
    expect(opsOn(await page(guessed, world_.cookie))).toEqual(opsOn(bare.get(tokenPane) ?? ""));
  });

  it(`§13 · an archived app's page keeps its catalog: after Archive is posted from the danger pane the banner page still lists the tools the app advertised and its Catalog marker is still that number · the same page listed them under the same marker before the archive (the twin)`, async () => {
    const slug = uniqueSlug("kept");
    const tools = [
      { name: uniqueSlug("kept").replace(/-/g, "_"), description: "One.", inputSchema: { type: "object" } },
      { name: uniqueSlug("held").replace(/-/g, "_"), description: "Two.", inputSchema: { type: "object" } },
    ];
    // `close()` first, so nothing below depends on the socket staying open.
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools });
    await close();

    // BEFORE — the twin, and what makes "still" mean anything.
    const landing = catalogPane(slug);
    const before = await appPage(landing);
    for (const tool of tools) expect(textOf(before), tool.name).toContain(tool.name);
    expect(markerOn(before, landing)).toBe("2");
    expect(textOf(before)).not.toContain(ARCHIVED_BANNER);

    // Archive through the pane's own control, as the browser posts it.
    const dangerPane = paths.appPane(slug, "danger");
    const dialog = await appPage(paths.appConfirm(slug, "danger", "archive"));
    const posted = await formPost(
      actionFor(dialog, "app_archive"),
      submissionOf(dialog),
      detail.session.cookie,
    );
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe(`${dangerPane}?done=app_archive`);

    // AFTER: the retained catalog, under the same marker — explicitly not "", not "—",
    // not "0", so a seam that answered "unreadable" for an archived app fails here.
    const answered = await get(landing, detail.session.cookie);
    expect(answered.status).toBe(200);
    const after = await answered.text();
    expect(textOf(after)).toContain(ARCHIVED_BANNER);
    for (const tool of tools) expect(textOf(after), tool.name).toContain(tool.name);
    expect(markerOn(after, landing)).toBe("2");

    // The world is SHARED — `dialTunnel` seeds into `detail.ns`, which four describes read
    // — so this row puts back the one thing it changed rather than leaving an archived app
    // behind for whoever enumerates that namespace next.
    await ops.app_unarchive.handler(detail.ns.owner.userId, { slug });
  });
});

describe(`§13 · /apps/<slug> — refusals and reserved segments`, () => {

  it(`§13 · /apps/pmcp, an unknown slug and another namespace's real slug are one 404, byte-identical — reserved, nonexistent and foreign are indistinguishable, and app_get refuses pmcp the same way · the owner's own app renders at the same shape (the twin)`, async () => {
    const foreignSlug = uniqueSlug("foreign");
    const foreign = await seedNamespace(env.DB, { apps: [{ slug: foreignSlug, kind: "tunnel" }] });
    const theirs = await seedOwnerSession(foreign.owner);

    const answers = [];
    for (const slug of [PMCP_SLUG, uniqueSlug("nope"), foreignSlug]) {
      const response = await get(paths.appDetail(slug));
      answers.push({ slug, status: response.status, text: await response.text() });
    }
    for (const answer of answers) expect(answer.status, answer.slug).toBe(404);
    // A probe learns nothing about WHICH of reserved, nonexistent and foreign it hit.
    for (const answer of answers.slice(1)) {
      expect({ status: answer.status, text: answer.text }).toEqual({
        status: answers[0].status,
        text: answers[0].text,
      });
    }
    // Non-vacuity of the foreign leg: the row exists — this owner's pages read only their
    // own namespace.
    expect(await page(paths.appDetail(foreignSlug), theirs.cookie)).toContain(foreignSlug);

    // Page and op agree on the builtin, which has not vanished: app_list still flags it.
    await expect(ops.app_get.handler(world.ns.owner.userId, { slug: PMCP_SLUG })).rejects.toThrow(
      new RegExp(PMCP_SLUG),
    );
    const listed = (await ops.app_list.handler(world.ns.owner.userId, {})) as {
      apps: { slug: string; builtin?: boolean }[];
    };
    expect(listed.apps.find((row) => row.slug === PMCP_SLUG)?.builtin).toBe(true);

    // The twin.
    expect((await get(paths.appDetail("news"))).status).toBe(200);
  });

  it(`§13 · /apps/new still renders the add-app form and POST /apps/connect still starts the upstream redirect — a static segment mounted under /apps/ wins over the slug route, which answers the 404 for every other name (the twin)`, async () => {
    // GET: `new` is a page, not a slug — the add-app form, whose op says so.
    const added = await page(paths.appNew);
    expect(formsRenderedOn(added).map((form) => form.op)).toContain("app_create");
    expect((await get(paths.appDetail(uniqueSlug("nope")))).status).toBe(404);

    // POST: `connect` is a mounted route (beginConnect's redirect or its own noticeUrl
    // refusal — either is the mounted route answering), while any other name falls to the
    // generic /apps/:op dispatch's "No such action".
    const csrf = csrfOf(await page(paths.apps));
    const connected = await post(paths.appConnect("notion"), {}, { csrf });
    expect(connected.status).toBe(303);
    const unmounted = await post(`/apps/${uniqueSlug("nope")}`, {}, { csrf });
    expect(unmounted.status).toBe(404);
    // The ANSWER, not just the code: the page router's own tail answers 404 here too, so
    // status alone stays green with the `/apps/:op` dispatch deleted outright — and it is
    // this dispatch's answer that routes.test.ts's derivation reads as its control.
    expect(await unmounted.text()).toBe("No such action\n");

    // The twin, so "static wins" does not read as "the slug route is broken".
    expect((await get(paths.appDetail("news"))).status).toBe(200);
  });

  it(`§13 · every /apps/<slug> pane is behind the ordinary owner session: an anonymous GET of the detail page and of each of the seven pane URLs bounces to /login, and so does a bearer with no cookie · the same URLs under the owner's cookie render (the twin)`, async () => {
    // Derived off `paths`, so a pane added later is walked with no edit here.
    const walked = appPaneHrefs("news");
    let seen = 0;
    for (const path of walked) {
      const anonymous = await call(new Request(`${ORIGIN}${path}`));
      expect(anonymous.status, path).toBe(302);
      expect(anonymous.headers.get("Location") ?? "", path).toMatch(/^\/login(\?|$)/);

      // A bearer with no cookie is nothing on a page route (requireOwnerSession's contract).
      const bearer = await call(
        new Request(`${ORIGIN}${path}`, { headers: { Authorization: `Bearer ${world.deviceToken}` } }),
      );
      expect(bearer.status, path).toBe(302);
      expect(bearer.headers.get("Location") ?? "", path).toMatch(/^\/login(\?|$)/);

      expect((await get(path)).status, path).toBe(200);
      seen += 1;
    }
    expect(seen).toBe(appPaneHrefs("probe").length);
  });

  it(`§13 · /apps/<slug> is the ordinary owner session and nothing stricter: the day-old cookie the six /settings panes bounce to /login renders the app page, all seven of its panes, and posts the danger pane's own Archive form (the other half of §13's gate sentence)`, async () => {
    const slug = uniqueSlug("gated");
    const agent = uniqueSlug("gateagent");
    const world_ = await seedTunneledApp(slug, { agent });
    // Two sign-ins for one owner: ageing one cannot age the other.
    const stale = await seedOwnerSession(world_.ns.owner);
    const fresh = await seedOwnerSession(world_.ns.owner);
    await ageSession(stale.token);

    // PRECONDITION, not the claim: it proves the legs below are about the credential §13
    // distinguishes.
    for (const pane of PANES) {
      const bounced = await get(pane, stale.cookie);
      expect(bounced.status, pane).toBe(302);
      expect(bounced.headers.get("Location") ?? "", pane).toMatch(/^\/login(\?|$)/);
    }

    // THE CLAIM, before any mutation.
    const walked = appPaneHrefs(slug);
    let seen = 0;
    for (const path of walked) {
      expect((await get(path, stale.cookie)).status, path).toBe(200);
      // THE CONTROL: the same eight under a fresh cookie, so the 200s above are not this
      // row leaning on §13's separate archived-page rule.
      expect((await get(path, fresh.cookie)).status, path).toBe(200);
      seen += 1;
    }
    expect(seen).toBe(appPaneHrefs("probe").length);

    // THE POST SIDE, last and sharpest: a recency gate gates mutations, not only reads.
    // The CSRF token rides as the STALE session's own, read off its own dialog render, so
    // the acceptance cannot be the CSRF check answering.
    const dangerPane = paths.appPane(slug, "danger");
    const dialog = await page(paths.appConfirm(slug, "danger", "archive"), stale.cookie);
    const posted = await formPost(actionFor(dialog, "app_archive"), submissionOf(dialog), stale.cookie);
    expect(posted.status).toBe(303);
    expect(posted.headers.get("Location")).toBe(`${dangerPane}?done=app_archive`);
    const listed = (await ops.app_list.handler(world_.ownerId, {})) as {
      apps: { slug: string; archived: boolean }[];
    };
    expect(listed.apps.find((row) => row.slug === slug)?.archived).toBe(true);
  });
});

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

/**
 * Every mutating target that fronts no ops key, by name. Three are §8's pinned browser
 * interactions — the consent redirect, the per-browser push subscription, and the device
 * decision — and the rest are better-auth's own endpoints, which the shell's Sign out puts
 * on every page. A target outside this set and outside admin.ops is exactly the drift
 * cases 16 and 17 exist to catch.
 *
 * An exclusion here is a debt owed to another case, never a hole (§9 rule 4a). Two of the
 * three are paid in this file: "decide" by cases 28 and 29, which submit that form both
 * ways and follow the flow to the CLI's redemption, and the better-auth targets by case
 * 24's walk. "connect" and "push" are the ones still owed.
 */
/**
 * The app page's three Save targets that are op-SHAPED without being ops (§4/§5/§6): each
 * composes ONE `app_update` or `grant_set` out of fields that are not that op's keys, so
 * Direction B's field-set equality cannot describe them — exactly as the agent page's own
 * grant editor is exempted. What each composes is pinned by its own describe.
 */
const COMPOSED_APP_TARGETS: ReadonlySet<string> = new Set(["role_set", "recording_set", "grant_set"]);

const BROWSER_ONLY_TARGETS: ReadonlySet<string> = new Set([
  "connect",
  "push",
  "decide",
  ...BETTER_AUTH_ACTIONS,
]);

/** Every session-backed page, rendered — the walk's input for case 4. */
async function sessionPages(): Promise<Record<string, string>> {
  const { userCode } = await requestDeviceCodes();
  const rendered: Record<string, string> = {};
  for (const path of [
    paths.apps,
    paths.appNew,
    paths.approvals,
    paths.approval(world.approvalId),
    paths.audit,
    // All six panes, not just the landing one: a pane is a route, and a form that forgot
    // its CSRF field on /settings/tokens is as unposted as one that forgot it on /apps.
    ...PANES,
    // And all eight of the app page's, for the same reason — otherwise the whole mutating
    // surface of `/apps/<slug>` is claimed by no walk, an exclusion with no debtor.
    ...appPaneHrefs("notion"),
    `${paths.device}?user_code=${encodeURIComponent(userCode)}`,
  ]) {
    rendered[path] = await page(path);
  }
  return rendered;
}

/** /audit under a set of filters, spelled the way a link on the page spells it. */
function auditPath(filters: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) search.set(name, String(value));
  return `${paths.audit}?${search.toString()}`;
}

/** The "N events match" line, as a number. */
function matchedLine(html: string): number {
  const rendered = /([\d,]+) events match/.exec(html)?.[1];
  if (rendered === undefined) throw new Error("the page rendered no \"N events match\" line");
  return Number(rendered.replace(/,/g, ""));
}

/** The seeded tool names the page actually drew, in order — one per rendered row. */
function renderedTools(html: string): string[] {
  return [...html.matchAll(new RegExp(`>(${TOOL_PREFIX}\\d+)<`, "g"))]
    .map((match) => match[1])
    .filter((tool, at, all) => all.indexOf(tool) === at);
}

/**
 * The pager's "next page" href, or null when the page does not offer one. The two arrows
 * are the same element with the same class, so they are told apart by the one thing that
 * differs — the chevron each draws. That is markup, and this is the one place this file
 * reads any: a walk of "the page's own next link" has nothing else to grip.
 */
function nextPageLink(html: string): string | null {
  const RIGHT_CHEVRON = "m9 18 6-6-6-6";
  for (const anchor of html.matchAll(/<a class="btn-icon" href="([^"]+)">([\s\S]*?)<\/a>/g)) {
    if (anchor[2].includes(RIGHT_CHEVRON)) return decodeEntities(anchor[1]);
  }
  return null;
}

/** The mobile "Load more" href, or null at the end of the set. */
function loadMoreLink(html: string): string | null {
  const block = /<a class="btn btn--outline btn--block" href="([^"]+)">\s*Load more/.exec(html);
  return block === null ? null : decodeEntities(block[1]);
}

/** Every chevron link an /audit render draws — the label says which way it points. */
function expandLinks(html: string): { label: string; href: string; query: URLSearchParams }[] {
  const anchors = html.matchAll(/<a class="row-toggle" aria-label="((?:Show|Hide) detail)" aria-expanded="(?:true|false)" href="([^"]+)"/g);
  return [...anchors].map((anchor) => {
    const href = decodeEntities(anchor[2] ?? "");
    return { label: anchor[1] ?? "", href, query: new URL(href, ORIGIN).searchParams };
  });
}

/** The ?session=… link inside the OPEN detail row — every row's detail is in the page,
 *  so the first session link on it is not necessarily the expanded row's. */
function sessionLink(html: string): string | null {
  const open = /<tr class="row-detail" id="detail-\d+">([\s\S]*?)<\/tr>/.exec(html);
  const link = open === null ? null : /href="(\/audit\?[^"]*session=[^"]*)"/.exec(open[1] ?? "");
  return link === null ? null : decodeEntities(link[1] ?? "");
}

/** The export, parsed — one AuditRow per line, exactly as audit.exportJsonl frames it. */
async function exportLines(filters: Record<string, string | number>): Promise<AuditRow[]> {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(filters)) search.set(name, String(value));
  const response = await get(`${paths.audit}/export.jsonl?${search.toString()}`);
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

/** §13's six settings panes in rail order, read through `paths` and never respelled. */
const PANES: readonly string[] = [
  paths.settings,
  paths.settingsTwoFactor,
  paths.settingsPasskeys,
  paths.settingsSessions,
  paths.settingsTokens,
  paths.settingsClients,
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

/** Does the page LINK this exact URL? An href comes back through the URL decoder, so an
 *  `&` the renderer escaped compares equal without either side spelling the entity — and
 *  the compare is EXACT, so `?confirm=archive` is not satisfied by a longer query. */
function links(html: string, href: string): boolean {
  return [...html.matchAll(/href="([^"]*)"/g)].some((anchor) => decodeEntities(anchor[1]) === href);
}

/** The set of ops one render's posting forms front, sorted — how "this query drew a dialog
 *  the bare pane does not" is compared without reading a class or a copy string. */
function opsOn(html: string): string[] {
  return [...new Set(formsRenderedOn(html).map((form) => form.op))].filter(inPane).sort();
}

/** Strictly more, as a set: everything `fewer` has, plus at least one it does not. A page
 *  that renders an op inline AND behind a dialog therefore cannot fail for the wrong
 *  reason, which a set DIFFERENCE would make it do. */
function supersets(more: string[], fewer: string[]): boolean {
  return fewer.every((op) => more.includes(op)) && more.length > fewer.length;
}

/** Every posting form's action on one rendered page, sorted — the shape "this query drew a
 *  form the bare pane does not" is compared as. */
/** The shell's own sign-out rides every signed-in page, so it is never a pane's form. */
function inPane(op: string): boolean {
  return op !== "sign-out";
}

function formsOn(html: string): string[] {
  const actions: string[] = [];
  for (const form of html.matchAll(/<form\b([^>]*)>/g)) {
    if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "post") continue;
    actions.push(decodeEntities(attributeOf(form[1], "action") ?? ""));
  }
  return actions.sort();
}

/**
 * Every POST target the six panes render, with the pane that drew it and the submission it
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


/* ------------------------------------------------------------------ *
 * /apps/<slug> — the helpers its rows share
 * ------------------------------------------------------------------ */

/** One of this describe's pages under ITS OWN session: `page` defaults to the file
 *  world's cookie, a different owner, and asserts 200 — so an omitted cookie would fail
 *  as a login bounce rather than as the property under test. */
function appPage(path: string): Promise<string> {
  return page(path, detail.session.cookie);
}

/** One app as §8's own read reports it — what the header is asserted AGAINST, rather
 *  than the spec the seed was written from. */
async function appRowOf(slug: string): Promise<AppSummaryRow> {
  const answered = (await ops.app_get.handler(detail.ns.owner.userId, { slug })) as { app: AppSummaryRow };
  return answered.app;
}

/** Every GET form a page renders, as its target and the controls it submits — the filter
 *  rows, which are forms with no op behind them and so are invisible to Direction B. */
function getFormsOn(html: string): { action: string; fields: string[] }[] {
  const found: { action: string; fields: string[] }[] = [];
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)) {
    if ((attributeOf(form[1], "method") ?? "get").toLowerCase() !== "get") continue;
    found.push({
      action: decodeEntities(attributeOf(form[1], "action") ?? ""),
      fields: namedControls(form[2]).sort(),
    });
  }
  return found;
}

/** The `sel` values one pane's own rows carry — the listing's links read as what they
 *  SELECT rather than as the bytes the renderer chose to encode them in. */
function selValuesOn(html: string, paneHref: string): string[] {
  const found: string[] = [];
  for (const anchor of html.matchAll(/<a\b([^>]*)>/g)) {
    const href = decodeEntities(attributeOf(anchor[1], "href") ?? "");
    if (href === "") continue;
    const url = new URL(href, ORIGIN);
    const sel = url.searchParams.get("sel");
    if (url.pathname === paneHref && sel !== null) found.push(sel);
  }
  return found;
}

/** One listing row's own markup — the slice from its `?sel=` anchor to the next one, which
 *  is what makes "the row stays one line" a claim about THAT row and not about the pane. */
function rowMarkupFor(html: string, sel: string): string {
  const rows = [...html.matchAll(/<a\b([^>]*)>/g)].filter((anchor) => {
    const href = decodeEntities(attributeOf(anchor[1], "href") ?? "");
    return href !== "" && new URL(href, ORIGIN).searchParams.get("sel") !== null;
  });
  const at = rows.findIndex((anchor) => {
    const href = decodeEntities(attributeOf(anchor[1], "href") ?? "");
    return new URL(href, ORIGIN).searchParams.get("sel") === sel;
  });
  if (at < 0) throw new Error(`no listing row selects "${sel}"`);
  return html.slice(rows[at].index ?? 0, at + 1 < rows.length ? rows[at + 1].index : html.length);
}

/** The details pane's own markup — the right-hand half of a split pane. A claim about
 *  what the details say must not be answerable by the shell's own navigation, whose
 *  "Approvals" link contains "Approval" on every signed-in page. */
function detailsPaneOf(html: string): string {
  const at = html.indexOf('class="details"');
  if (at < 0) throw new Error("the pane rendered no details");
  return html.slice(at);
}

/** The level the page chose, read off the root's own attribute — the one place §13's
 *  narrow ladder exists at all, since which level is showing is otherwise CSS's business. */
function levelOf(html: string): string {
  return /\bdata-level="(\d)"/.exec(html)?.[1] ?? "";
}

/** One app-rail entry's own markup — where the Recording dot lives, which is a marker no
 *  text walk can see (its state is in the class and its word is `sr-only`). */
function appRailAnchor(html: string, slug: string, href: string): string {
  const block = navBlock(html, APP_RAIL_NAV_LABEL) ?? "";
  const anchor = [...block.matchAll(/<a\b([^>]*)>[\s\S]*?<\/a>/g)].find(
    (candidate) => decodeEntities(attributeOf(candidate[1], "href") ?? "") === href,
  );
  if (anchor === undefined) throw new Error(`the app rail of "${slug}" carries no entry for "${href}"`);
  return anchor[0];
}

/** One pane's marker read off THIS render's app rail — never off another pane's copy of
 *  the rail, and never off "the anchor with that href", which the pill row repeats
 *  markerless (`Number("")` is 0, not NaN). */
function markerOn(html: string, href: string): string {
  const entry = railEntries(html, APP_RAIL_NAV_LABEL).find((row) => row.href === href);
  if (entry === undefined) throw new Error(`the app rail carries no entry for "${href}"`);
  return entry.marker;
}

/** A §13 quote as the page renders it: only the markdown backticks come off, because the
 *  page draws those spans as markup and `textOf` has already dropped the tags. Everything
 *  else stays byte-identical with the spec's own sentence. */
function pinned(sentence: string): string {
  return sentence.replace(/`/g, "");
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

/** The header's last-seen value, without pinning its format: §13 gives a tunneled app a
 *  last seen, and this reads whatever word the page put after the label. */
function lastSeenOf(html: string): string {
  return /Last seen (\S+)/.exec(textOf(html))?.[1] ?? "";
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

/** One listing on the scoped endpoint under this describe's OWN owner bearer — `user:<name>`,
 *  the principal §7 step 2 leaves unfiltered, which is what makes the comparison fair. */
async function scopedList(
  slug: string,
  method: string,
): Promise<Record<string, { name: string; uri?: string; uriTemplate?: string }[] | undefined>> {
  const answered = await call(
    new Request(`${ORIGIN}${paths.mcpScoped(detail.ns.owner.username, slug)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${detail.bearer}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    }),
  );
  const body = (await answered.json()) as { result?: Record<string, { name: string }[] | undefined> };
  return body.result ?? {};
}

/** Every agent's grants ON CATALOG, `agent_list`'s own spelling parsed back into the
 *  entries the door takes — so "no agent reaches it" is the matcher's answer rather than
 *  the fixture's claim. */
async function grantsOnCatalog(): Promise<Record<string, GrantEntry[]>> {
  const listed = (await ops.agent_list.handler(detail.ns.owner.userId, {})) as {
    agents: { slug: string; grants: Record<string, string[]> }[];
  };
  const held: Record<string, GrantEntry[]> = {};
  for (const agent of listed.agents) {
    const spelled = agent.grants[CATALOG] ?? [];
    if (spelled.length === 0) continue;
    held[agent.slug] = spelled.map((entry) => {
      const at = entry.indexOf(":");
      return at < 0
        ? { role: entry, mode: "allow" as const }
        : { role: entry.slice(0, at), mode: "approval" as const };
    });
  }
  return held;
}

/**
 * Drive BROKEN into `needs_reconnect` the one way §7 allows: connect it for real against
 * the fake authorization server, then make one call whose proactive refresh that server
 * rejects. The flag lives inside the stored ciphertext, so nothing here pokes a column,
 * and the precondition is read back through §8's own row rather than through the seam
 * under test.
 */
async function breakBrokensCredential(): Promise<void> {
  const app = await new Registry(env.DB).getApp(detail.ns.owner.userId, BROKEN);
  if (app === null) throw new Error("the app-detail fixture's oauth app vanished");
  const started = await beginConnect(app, { id: await sessionIdOf(detail.session.cookie) });
  const redirected = await fetch(started.toString(), { redirect: "manual" });
  const callbackUrl = redirected.headers.get("Location");
  if (callbackUrl === null) throw new Error("the fake AS answered no redirect");
  const completed = await call(new Request(callbackUrl, { headers: { Cookie: detail.session.cookie } }));
  expect(completed.status, "the upstream callback").toBe(302);
  // `stale_first_token` makes the stored access token dead on arrival, so the next call
  // must refresh before it forwards — and `refresh_fails` rejects that refresh.
  await call(
    new Request(`${ORIGIN}${paths.mcpScoped(detail.ns.owner.username, BROKEN)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${detail.ns.tokens.breaker.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "paper_fetch", arguments: {} },
      }),
    }),
  );
  const row = await appRowOf(BROKEN);
  if (row.connection !== "needs_reconnect") {
    throw new Error(`the refresh did not fail for "${BROKEN}": ${String(row.connection)}`);
  }
}

/**
 * A real tunneled app of this describe's own, on the other end of §6's wire — seeded, its
 * credential minted, and dialled hand-rolled through `worker.fetch`, because
 * `harness/fake-app` is pinned to the `tunnel` project and a socket is not (hygiene's own
 * sockets are dialled the same way).
 *
 * Its `server/discover` answer carries a FAMILY-KEYED OBJECT, which is the only spelling
 * that declares anything: tunnel keeps the capabilities whose KEY is present, so the array
 * spelling declares none and would clear the very catalogs these rows list (§20.5).
 *
 * It SETTLES both transitions rather than sleeping through them — it returns only once the
 * scoped endpoint serves what the app advertised, and its `close()` resolves only once
 * `app_get` reports the app offline.
 */
async function dialTunnel(
  slug: string,
  serves: {
    capabilities: readonly AppCapability[];
    tools?: { name: string; [key: string]: unknown }[];
    prompts?: { name: string; [key: string]: unknown }[];
    resources?: { uri: string; [key: string]: unknown }[];
    resourceTemplates?: { uriTemplate: string; [key: string]: unknown }[];
  },
): Promise<() => Promise<void>> {
  const ownerId = detail.ns.owner.userId;
  const app = await seedApp(env.DB, ownerId, { slug, kind: "tunnel", name: slug });
  const credential = await seedToken(ownerId, "app", app.id, slug, { as: slug });
  const response = await call(
    new Request(`${ORIGIN}/connect`, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${credential.token}` },
    }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    throw new Error(`/connect refused the upgrade: ${response.status}`);
  }
  socket.accept();
  const declared: Record<string, unknown> = {};
  for (const family of serves.capabilities) declared[family] = {};
  socket.addEventListener("message", (event) => {
    const frame = JSON.parse(String((event as MessageEvent).data)) as { id?: unknown; method?: unknown };
    const answer = (body: Record<string, unknown>): void =>
      socket.send(JSON.stringify({ jsonrpc: "2.0", id: frame.id, ...body }));
    if (frame.method === "server/discover") answer({ result: { capabilities: declared } });
    else if (frame.method === "tools/list") answer({ result: { tools: serves.tools ?? [] } });
    else if (frame.method === "prompts/list") answer({ result: { prompts: serves.prompts ?? [] } });
    else if (frame.method === "resources/list") answer({ result: { resources: serves.resources ?? [] } });
    else if (frame.method === "resources/templates/list")
      answer({ result: { resourceTemplates: serves.resourceTemplates ?? [] } });
  });
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id: "register",
      method: "hub/register",
      params: { clientVersion: "web-pages/0", protocolVersion: "2026-07-28", roles: {} },
    }),
  );
  const family = serves.tools === undefined ? "prompts" : "tools";
  const advertised = (serves.tools ?? serves.prompts ?? []).length;
  await until(
    async () => ((await scopedList(slug, `${family}/list`))[family] ?? []).length === advertised,
    `the "${slug}" catalog never warmed`,
  );
  return async () => {
    try {
      socket.close(1000, "case teardown");
    } catch {
      // already gone
    }
    await until(async () => (await appRowOf(slug)).status === "offline", `"${slug}" never went offline`);
  };
}

/** Poll a state to a budget — what every socket fixture in this repo does instead of
 *  sleeping, because "warm" and "offline" are states nothing signals. */
async function until(ready: () => Promise<boolean>, complaint: string): Promise<void> {
  for (let turn = 0; turn < 250; turn += 1) {
    if (await ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(complaint);
}
