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
// name form fields, row counts, and status codes; never markup, copy, or layout.

// deps: harness/seed · src/index (exports.default.fetch) · src/admin (ops — one handler substituted to prove non-execution) · src/audit · src/approvals · src/identity (session minting) · src/principal (tokenPattern) · applyD1Migrations

import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { ops } from "../../src/admin";
import type { AdminOp } from "../../src/admin";
import { APP_PANES } from "../../src/app-routes";
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
import type { App, AppCapability, GrantEntry } from "../../src/registry";
import { beginConnect } from "../../src/upstream";
import { registerOverride, upstreamUrlFor } from "../harness/fake-upstream";
import type { AsScenario, UpstreamScenario } from "../harness/fake-upstream";
import { seedApp, seedNamespace, seedOwnerCredential, seedOwnerSession, seedToken, SEEDED_OWNER_PASSWORD, uniqueSlug } from "../harness/seed";
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
    expect(completed.headers.get("Location")).toContain(paths.apps);
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
      expect(answered.status).toBe(303);
      // `done=`, not `failed=`: better-auth accepted the password this form carried. The
      // refusal leg is the POST-prefix walk's, where a wrong one comes back as `failed=`.
      expect(answered.headers.get("Location")).toContain("done=");
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
      expect(answered.status).toBe(303);
      expect(answered.headers.get("Location")).toContain("done=");
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
    `§13 · one renderer emits every HTML page, so every one carries Content-Security-Policy "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" — checked on the three shapes: /login anonymous, /apps shelled under the owner's cookie, /apps/new chromeless — while the hub's non-HTML answers, /styles.css and the surface's 404, carry none (the twin)`,
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
      }

      // The twin, and the reason it is worth having: these two prove the header rides the
      // PAGE renderer rather than a blanket middleware over every response.
      const css = await call(new Request(`${ORIGIN}${paths.stylesheet}`));
      expect(css.status).toBe(200);
      expect(css.headers.get("Content-Type")).toContain("text/css");
      expect(css.headers.get("Content-Security-Policy")).toBeNull();

      const missing = await get(`${paths.appDetail("catalog")}/tools`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("Content-Type")).toContain("text/plain");
      expect(missing.headers.get("Content-Security-Policy")).toBeNull();
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

  it("§19.5 · a namespace with zero agents renders the picker's empty state naming /apps and disables submit — consent is impossible until an agent exists · the same page with one agent submits (the twin)", async () => {
    const empty = await seedNamespace(env.DB, {});
    const emptySession = await seedOwnerSession(empty.owner);
    const emptyClient = await registerOAuthClient();
    const emptyHtml = (
      await reachConsent(emptyClient.clientId, emptySession.cookie, { resource: oauthResourceFor(empty.owner.username) })
    ).html;
    expect(emptyHtml).toContain(paths.apps);
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
  it.todo(
    `§13 · /settings/passkeys names a row the way the authenticator reported it: a passkey stored with a known AAGUID and no name lists as "Windows Hello", one with the all-zero AAGUID that privacy-preserving platforms report lists as "Passkey", the marker reads 2 and each row links its own Remove dialog · with none, the pane renders "No passkeys yet. Add one to sign in without a password." and the marker reads 0 (the twin)`,
  );

  // plan row 7. The Sessions pane names each session's client, and the device flow mints the
  // one client no browser can — so the row reads both rows off a single render: the CLI's
  // device-flow suffix beside the browser session's own client without it, and the rail's
  // Sessions marker counting the two.
  it.todo(
    `§13 · a session minted by the device flow lists as "pmcp CLI · device flow" in the Sessions pane beside the browser session that rendered the page, which reads its own client with no device-flow suffix (the twin) — and the rail's Sessions marker counts both`,
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
  it.todo(
    `§4 · a day-old cookie is refused at BOTH passkey register endpoints with better-auth's SESSION_NOT_FRESH code — the GET options and the POST verify, the POST carrying an Origin so the refusal is the freshness gate and not the origin check, and a body that satisfies the endpoint's schema so it is not the validator either · from a session signed in moments ago the same two calls get past that gate, the GET answering 200 with a challenge and the POST failing the ceremony itself (the twin)`,
  );
});

describe(`§13/§15 · /settings/two-factor — the enrolment journey, in place`, () => {
  // Rows first (§9 rule 1): the enrolment renders in place — the POST answers with the card
  // instead of redirecting — and none of that exists yet. These six titles are what
  // "implemented" will mean for the secret, the codes and the six boxes.

  // plan row 1. Answering in place gives the minted secret exactly one carrier, this body, so
  // the row reads the grouped line, the verify form's hidden totpuri and the QR against the
  // "secret" parameter of that same answer's own otpauth URI — and the pane's next GET, the
  // state no route reaches today, is the twin that draws none of it.
  it.todo(
    `§13/§15 · POST /settings/two-factor/enable with the owner's own password answers 200 rendering the setup card in place — the secret better-auth minted reaches the page as the grouped line and again as the verify form's hidden totpuri, both equal to the "secret" parameter of that same answer's otpauth URI, beside a QR served as a data:image/svg+xml URI and the ten backup codes from the same answer — while the answer carries no Location and the pane's own next GET draws the not-enrolled arm with the secret, the codes and the QR nowhere in it (the twin)`,
  );

  // plan row 2. Rendering in place is what keeps the secret and the codes off a URL; this row
  // is the negative that makes it structural rather than incidental — the secret and all ten
  // codes in the bodies, no Location on either answer, and no href or form action on either
  // render carrying a "secret", an otpauth: URI or any code from the set.
  it.todo(
    `§13/§15 · nothing on the enrolment journey puts the secret or a backup code on a URL: the enable answer and the verify refusal both carry the secret and all ten codes in their bodies, and neither sets a Location, and no href or form action either render draws carries a "secret", an otpauth: or any code from the set`,
  );

  // plan row 3. Its named trap: a successful verify DELETES the session it ran under and mints
  // a new one, and `redirectWith` forwards those Set-Cookie headers onto the 303 — so the
  // cookie the test signed in with is dead the moment the POST returns and a follow-up GET
  // with it bounces to /login. The twin parses the new cookie off the 303 with sessionCookieOf.
  it.todo(
    `§13 · a wrong code posted to /settings/two-factor/verify-totp answers 200 redrawing the SAME enrolment — byte-identical secret, the boxes aria-invalid, better-auth's own "Invalid code" on the card, the ten codes still shown — and twoFactorEnabled is still 0 · the code generated from that same secret answers 303 and re-issues the session cookie, and the pane read with THAT cookie renders the enabled arm with the codes gone (the twin)`,
  );

  // plan row 4. One shared component, two consumers — the settings enrolment card and /login's
  // TOTP challenge — pinned on the field better-auth actually reads: a single "code". Today's
  // pane posts digit0…digit5 and could never verify, which is the twin's half.
  it.todo(
    `§13 · the six boxes are stitched into the one field better-auth reads: the settings enrolment card and /login's TOTP challenge both carry data-otp-form and both render the shared component's hidden [data-otp-value] input, its six [data-otp] boxes and the same handler text, and the settings card posts a "code" field · neither card posts a digit0 field, which is what a code typed into today's pane sends (the twin)`,
  );

  // plan row 5. The reveal happens in place too, which is what makes "fresh" checkable: none of
  // the ten codes the enrolment showed may appear in the new set. Its twins are the pane's next
  // GET, which reveals nothing, and the wrong password, which redirects with failed= instead.
  it.todo(
    `§13 · Regenerate backup codes answers 200 revealing a fresh set in place — ten codes, none of them from the set the enrolment showed — while the pane's next GET reveals none and a wrong password redirects with failed= instead (the twin)`,
  );

  // plan row 6. A Copy-codes control naming fewer codes than it drew is the drift this catches:
  // each code in its own [data-code] element and one handler reading all ten. The two arms that
  // reveal nothing render neither the control nor a code element (the twin).
  it.todo(
    `§13 · the reveal carries a Copy-codes control that names every code it drew: each code sits in its own [data-code] element and one handler reads all ten · the not-enrolled arm and the enabled arm render no Copy-codes control and no code element (the twin)`,
  );
});

/* ------------------------------------------------------------------ *
 * The two Access panes (§13's Tokens and Connected clients)
 * ------------------------------------------------------------------ */

/** §13's three Tokens-pane sentences, byte-for-byte. The footer is ONE string on purpose:
 *  its two sentences are quoted together and a split rendering is the drift these guard. */
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

  it(`§13 · a bound-to app slug links to /apps/<slug> · the agent slug beside it is plain text and no anchor on the pane names an /agents/ path (the twin — the agents pages are deferred)`, async () => {
    const html = await keysPage(paths.settingsTokens);
    expect(html, "the app row does not link its app").toContain(`href="${paths.appDetail(KEYS_APP)}"`);

    // INNER HTML, not text equality: `design/SettingsTokens.dc.html` draws these cells as
    // anchors, and a <span> wrapper inside one would defeat a text check.
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    expect(anchors.length, "the walk found no anchors at all").toBeGreaterThan(0);
    expect(textOf(html), "the agent slug is not on the pane").toContain(KEYS_AGENT);
    for (const anchor of anchors) {
      expect(anchor[2], "an anchor wraps the agent slug").not.toContain(KEYS_AGENT);
      expect(
        decodeEntities(attributeOf(anchor[1], "href") ?? ""),
        "an anchor names an /agents/ path",
      ).not.toContain("/agents/");
    }
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

  it(`§13/§19.5 · a connected client's row shows the name it registered with, the ORIGIN of its registered redirect URI beneath it — never the full URI — and the bound agent's slug as plain text under Acts as · a client that registered without a name shows its client id in the name's place (the twin)`, async () => {
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
    const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)];
    expect(anchors.length, "the walk found no anchors at all").toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor[2], "an anchor wraps the agent slug").not.toContain(AGENT);
      expect(
        decodeEntities(attributeOf(anchor[1], "href") ?? ""),
        "an anchor names an /agents/ path",
      ).not.toContain("/agents/");
    }
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

/** The §13 sentences these rows pin, spelled as §13 spells them — backticks included, so
 *  a reader can diff a literal against the spec; `pinned()` takes them off. */
const TOOLS_FOOTER =
  "Schemas come from the app's last `tools/list` — the hub stores them, it does not author them.";
const TUNNELED_TOOLS_HEADER = "Advertised by the app on its last connect. Re-listed on every reconnect";
const REFRESH_FAILED = "Token refresh failed — calls return errors until you reconnect.";
const SCHEMA_UNSOUND = "schema-unsound — approval-gated calls refuse, bodies are not recorded";
const NO_AGENT_YET = "Reachable by no agent yet";
const NO_REDACTED = "No redacted fields";
const NO_APPROVAL = "No approval required";
const APPROVAL_REQUIRED = "Approval required for";
const NEVER_GATED = "Never approval-gated";

/** §20's two rules, as §13 quotes them. The scoped-endpoint rule is spelled as its two
 *  unambiguous halves because its middle carries the endpoint itself, whose host half
 *  §13 leaves as a placeholder (the owner question constraint 32(c) records). */
const SCOPED_ONLY_HEAD = "Resources are served on the scoped endpoint only";
const SCOPED_ONLY_TAIL =
  "The aggregated endpoint answers `-32601`, because a URI cannot carry a slug prefix and stay the URI the app knows.";
const URI_NOT_NAME =
  "Grants match resources by URI, never by name — a role's resource patterns are URI patterns, and templates are matched against their raw `uriTemplate`.";

/** §13's Roles pane, per kind, plus the two lines an app that declared none renders. */
const ROLES_TUNNELED = "Declared by the app at connect time.";
const ROLES_TRUST =
  "Roles are self-declared by the tunneled app — granting a role trusts the app's declaration.";
const ROLES_PROXIED = "Roles are defined in config (virtual) for proxied apps.";
const ROLES_NONE = "No roles declared";
const ROLES_FALLBACK = "Grants fall back to the built-in `all` role — every tool, present and future.";

/** §15's two per-kind defaults, as §13 asks the Overview pane to name them. */
const LOG_BODIES_TUNNEL = "On — tunneled default";
const LOG_BODIES_PROXY = "Off — proxied default";

/** §20.2's proxied dimming sentence, and §20.5's tunneled pair, each with the family
 *  substituted exactly as §13 says they are. */
const proxiedOmits = (family: string): string =>
  `The \`capabilities\` configured for this app omit ${family} (§20.2) — add it with \`app_update\` or the YAML.`;
const tunneledUndeclared = (family: string): readonly string[] => [
  `This app declared no ${family} capability on its last connect, so the hub advertises none and serves an empty list.`,
  `Declare ${family} with your MCP SDK and they appear here after the next reconnect — the client library passes the declaration through untouched.`,
];

/** The eight pane URLs of one app, in §13's table order — built from `paths`, never
 *  spelled, and the landing pane first because the landing pane IS Tools. */
function appPaneHrefs(slug: string): string[] {
  return [paths.appDetail(slug), ...APP_PANES.map((pane) => paths.appPane(slug, pane))];
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

describe(`§13 · /apps/<slug> — the header and the Tools pane`, () => {
  beforeAll(withAppDetailWorld);

  it(`§13 · /apps/<slug>/tools is a 404 — the landing pane has no alias · /apps/<slug> renders Tools and each of the seven other panes answers 200 at its own URL, carrying aria-current="page" on its own rail entry and on no other (the twin)`, async () => {
    const aliased = await get(`${paths.appDetail(CATALOG)}/tools`, detail.session.cookie);
    expect(aliased.status, "GET /apps/<slug>/tools").toBe(404);

    // The landing pane IS Tools, said by the one line only that pane draws: its own
    // verbatim footer. A heading would prove less — the rail repeats every pane's label.
    expect(textOf(await appPage(paths.appDetail(CATALOG)))).toContain(pinned(TOOLS_FOOTER));

    const hrefs = appPaneHrefs(CATALOG);
    expect(hrefs).toHaveLength(8);
    for (const href of hrefs) {
      const current = railEntries(await appPage(href), APP_RAIL_NAV_LABEL).filter((entry) => entry.current);
      expect(current.map((entry) => entry.href), `aria-current on ${href}`).toEqual([href]);
    }
  });

  it(`§13 · the app rail carries exactly the eight entries of §13's pane table, App and Access as headings with the Danger zone ungrouped after them, and Overview and Danger zone carry no marker where the six others do (the twin)`, async () => {
    const html = await appPage(paths.appDetail(CATALOG));
    const rail = railEntries(html, APP_RAIL_NAV_LABEL);
    expect(rail.map((entry) => entry.href)).toEqual(appPaneHrefs(CATALOG));

    // The headings, positionally: §13 groups App then Access and leaves the Danger zone
    // ungrouped AFTER them, so the claim is about where each word falls among the labels.
    const text = textOf(navBlock(html, APP_RAIL_NAV_LABEL) ?? "");
    const at = (needle: string): number => {
      const found = text.indexOf(needle);
      expect(found, `the rail names "${needle}"`).toBeGreaterThanOrEqual(0);
      return found;
    };
    expect(at("App")).toBeLessThan(at("Tools"));
    expect(at("Overview")).toBeLessThan(at("Access"));
    expect(at("Access")).toBeLessThan(at("Agents"));
    expect(text.slice(at("Token"), at("Danger zone"))).not.toMatch(/App|Access/);

    const marker = new Map(rail.map((entry) => [entry.href, entry.marker]));
    const unmarked = [paths.appPane(CATALOG, "overview"), paths.appPane(CATALOG, "danger")];
    for (const href of unmarked) expect(marker.get(href), href).toBe("");
    for (const href of appPaneHrefs(CATALOG).filter((href) => !unmarked.includes(href))) {
      expect(marker.get(href), href).not.toBe("");
    }
    // The twin that keeps "no marker" from reading as "an empty marker": the Roles pane's
    // `none` is a marker STRING, and an app that declared no roles renders it.
    const fresh = railEntries(await appPage(paths.appDetail(FRESHAPP)), APP_RAIL_NAV_LABEL);
    expect(fresh.find((entry) => entry.href === paths.appPane(FRESHAPP, "roles"))?.marker).toBe("none");
  });

  it(`§13 · the header names the app, its slug and its kind badge — a tunneled app's status and last seen, a proxied app's endpoint, auth mode and forward identity read back from app_get's own row — and renders Connect/Reconnect and Disconnect only where auth is oauth · a headers-mode app renders neither target (the twin)`, async () => {
    const tunneled = await appRowOf(TUNNELAPP);
    const tunnelHtml = await appPage(paths.appDetail(TUNNELAPP));
    const tunnelText = textOf(tunnelHtml);
    expect(tunnelText).toContain(tunneled.name);
    expect(tunnelText).toContain(TUNNELAPP);
    expect(tunnelText).toMatch(/\btunnel\b/);
    // No socket is open in this describe, so §8's own row says offline and so must the page.
    expect(tunneled.status).toBe("offline");
    expect(tunnelText).toMatch(/\boffline\b/);

    // Last seen, without pinning a format: the app the beforeAll stamped and the one that
    // has never connected must not read the same.
    const freshHtml = await appPage(paths.appDetail(FRESHAPP));
    expect(lastSeenOf(tunnelHtml)).not.toBe("");
    expect(lastSeenOf(freshHtml)).not.toBe("");
    expect(lastSeenOf(tunnelHtml)).not.toBe(lastSeenOf(freshHtml));

    const proxied = await appRowOf(CATALOG);
    const catalogHtml = await appPage(paths.appDetail(CATALOG));
    const catalogText = textOf(catalogHtml);
    expect(catalogText).toContain(String(proxied.endpoint));
    expect(catalogText).toMatch(/\bproxy\b/);
    expect(catalogText).toMatch(/\bheaders\b/);
    expect(catalogText).toContain("Forward identity");

    // §13 gives an `auth: oauth` app all three controls; both targets are `paths`'s, so
    // the app page cannot invent a third spelling of what /apps already posts to.
    const brokenHtml = await appPage(paths.appDetail(BROKEN));
    expect(formsPostingTo(brokenHtml, paths.appConnect(BROKEN)).length).toBeGreaterThan(0);
    expect(formsPostingTo(brokenHtml, paths.appDisconnect(BROKEN)).length).toBeGreaterThan(0);
    // Read off the LIST's render and compared: /apps draws Connect as a submit button's
    // `formaction`, so the comparison is over every target either page posts to.
    expect(postTargets(await appPage(paths.apps))).toContain(paths.appConnect(BROKEN));
    expect(postTargets(brokenHtml)).toContain(paths.appConnect(BROKEN));
    // The header's state word is the one §8's row reports, `_` read as a space.
    const broken = await appRowOf(BROKEN);
    expect(textOf(brokenHtml).toLowerCase()).toContain(String(broken.connection).replace(/_/g, " "));

    // The twin: nothing dials in to a headers-mode app, so it draws neither target.
    expect(formsPostingTo(catalogHtml, paths.appConnect(CATALOG))).toEqual([]);
    expect(formsPostingTo(catalogHtml, paths.appDisconnect(CATALOG))).toEqual([]);
  });

  it(`§13 · every App-group rail marker is the number of rows its own pane lists — Tools, Prompts, and Resources as resources plus templates — and the Resources pane's two tabs carry those two counts at ?tab=resources and ?tab=templates`, async () => {
    const toolsHtml = await appPage(paths.appDetail(CATALOG));
    const toolsText = textOf(toolsHtml);
    for (const name of CATALOG_TOOL_NAMES) expect(mentions(toolsText, name), name).toBe(1);
    for (const name of [...CATALOG_PROMPT_NAMES, ...CATALOG_RESOURCE_URIS]) {
      expect(mentions(toolsText, name), `${name} on the Tools pane`).toBe(0);
    }
    expect(markerOn(toolsHtml, paths.appDetail(CATALOG))).toBe(String(CATALOG_TOOLS.length));

    const promptsHtml = await appPage(paths.appPane(CATALOG, "prompts"));
    const promptsText = textOf(promptsHtml);
    for (const name of CATALOG_PROMPT_NAMES) expect(mentions(promptsText, name), name).toBe(1);
    for (const name of [...CATALOG_TOOL_NAMES, ...CATALOG_RESOURCE_URIS]) {
      expect(mentions(promptsText, name), `${name} on the Prompts pane`).toBe(0);
    }
    expect(markerOn(promptsHtml, paths.appPane(CATALOG, "prompts"))).toBe(String(CATALOG_PROMPTS.length));

    // The marker is the two tabs SUMMED, read off the pane being counted.
    const resourcesUrl = paths.appPane(CATALOG, "resources");
    const templatesUrl = `${resourcesUrl}?tab=templates`;
    const resourcesHtml = await appPage(resourcesUrl);
    const templatesHtml = await appPage(templatesUrl);
    const summed = String(CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length);
    expect(markerOn(resourcesHtml, resourcesUrl)).toBe(summed);
    expect(markerOn(templatesHtml, resourcesUrl)).toBe(summed);

    for (const [html, listed, hidden] of [
      [resourcesHtml, CATALOG_RESOURCE_URIS, CATALOG_TEMPLATE_URIS],
      [templatesHtml, CATALOG_TEMPLATE_URIS, CATALOG_RESOURCE_URIS],
    ] as const) {
      const text = textOf(html);
      for (const uri of listed) expect(mentions(text, uri), uri).toBe(1);
      for (const uri of hidden) expect(mentions(text, uri), `${uri} on the other tab`).toBe(0);
      for (const name of [...CATALOG_TOOL_NAMES, ...CATALOG_PROMPT_NAMES]) {
        expect(mentions(text, name), `${name} on the Resources pane`).toBe(0);
      }
      // Both tab links render on both tabs, each carrying its own count.
      expect(linkTexts(html, resourcesUrl)).toContain(`Resources ${CATALOG_RESOURCES.length}`);
      expect(linkTexts(html, templatesUrl)).toEqual([`Templates ${CATALOG_TEMPLATES.length}`]);
    }
    // The bare pane URL is the Resources tab, not a third state.
    expect(textOf(await appPage(`${resourcesUrl}?tab=resources`))).toBe(textOf(resourcesHtml));
  });

  it(`§20.2/§13 · a tunneled app that declares prompts at registration carries a prompts count and lists them, while the app beside it that declared none dims to — (the twin), and the same live registration renders the header's online status and a last seen the never-connected app has not got`, async () => {
    const slug = uniqueSlug("declares");
    const served = [
      { name: uniqueSlug("brief").replace(/-/g, "_"), description: "One." },
      { name: uniqueSlug("recap").replace(/-/g, "_"), description: "Two." },
    ];
    const close = await dialTunnel(slug, { capabilities: ["tools", "prompts"], prompts: served });
    try {
      const html = await appPage(paths.appDetail(slug));
      expect(markerOn(html, paths.appPane(slug, "prompts"))).toBe(String(served.length));
      expect(markerOn(html, paths.appPane(slug, "resources"))).toBe(DIMMED_MARKER);
      const promptsText = textOf(await appPage(paths.appPane(slug, "prompts")));
      for (const prompt of served) expect(promptsText).toContain(prompt.name);
      // The family it did NOT declare renders the tunneled empty state instead.
      const resourcesText = textOf(await appPage(paths.appPane(slug, "resources")));
      for (const sentence of tunneledUndeclared("resources")) expect(resourcesText).toContain(pinned(sentence));

      // The twin, same kind and same render path: the app that declared nothing dims.
      expect(markerOn(await appPage(paths.appDetail(TUNNELAPP)), paths.appPane(TUNNELAPP, "prompts"))).toBe(
        DIMMED_MARKER,
      );

      expect(textOf(html)).toMatch(/\bonline\b/);
      expect(lastSeenOf(html)).not.toBe(lastSeenOf(await appPage(paths.appDetail(FRESHAPP))));
    } finally {
      await close();
    }
  });

  it(`§20.2/§13 · a family the app advertises none of dims its rail entry to — and its pane renders the empty state that says why, verbatim, per kind, with the family name substituted · the families it does advertise carry counts and list rows (the twin)`, async () => {
    // Proxied: PLAIN declared no `capabilities` at all, which §20.2 reads as tools only.
    const plainHtml = await appPage(paths.appDetail(PLAIN));
    expect(markerOn(plainHtml, paths.appDetail(PLAIN))).toBe(String(PLAIN_TOOLS.length));
    expect(textOf(plainHtml)).toContain(PLAIN_TOOLS[0].name);
    for (const family of ["prompts", "resources"] as const) {
      const href = paths.appPane(PLAIN, family);
      expect(markerOn(plainHtml, href)).toBe(DIMMED_MARKER);
      // A dimmed entry is still a link — §13 says so in as many words.
      expect(railEntries(plainHtml, APP_RAIL_NAV_LABEL).map((entry) => entry.href)).toContain(href);
      expect(textOf(await appPage(href))).toContain(pinned(proxiedOmits(family)));
    }

    // Tunneled: the same absence, said the other way (§20.5).
    const tunnelHtml = await appPage(paths.appDetail(TUNNELAPP));
    for (const family of ["prompts", "resources"] as const) {
      expect(markerOn(tunnelHtml, paths.appPane(TUNNELAPP, family))).toBe(DIMMED_MARKER);
      const text = textOf(await appPage(paths.appPane(TUNNELAPP, family)));
      for (const sentence of tunneledUndeclared(family)) expect(text).toContain(pinned(sentence));
    }

    // Non-vacuity: the app that advertises all three renders neither sentence anywhere.
    const catalogText = textOf(await appPage(paths.appPane(CATALOG, "prompts")));
    expect(catalogText).not.toContain(pinned(proxiedOmits("prompts")));
    expect(catalogText).not.toContain(pinned(tunneledUndeclared("prompts")[0]));
  });

  it(`§13 · a proxied app whose live listing fails renders BLANK App-group markers, never — and never 0, and its Tools pane renders "Token refresh failed — calls return errors until you reconnect." beside Reconnect instead of an empty list · a reachable app's markers are numbers and its Tools pane lists rows (the twin)`, async () => {
    await breakBrokensCredential();

    const html = await appPage(paths.appDetail(BROKEN));
    for (const href of [
      paths.appDetail(BROKEN),
      paths.appPane(BROKEN, "prompts"),
      paths.appPane(BROKEN, "resources"),
    ]) {
      // BROKEN declared all three families, so `—` here would itself be the bug, and `0`
      // would be the "an unread count is not an empty set" one.
      expect(markerOn(html, href), href).toBe("");
      expect(markerOn(html, href), href).not.toBe(DIMMED_MARKER);
      expect(markerOn(html, href), href).not.toBe("0");
    }
    expect(textOf(html)).toContain(pinned(REFRESH_FAILED));
    expect(formsPostingTo(html, paths.appConnect(BROKEN)).length).toBeGreaterThan(0);
    expect(mentions(textOf(html), `${BROKEN}_`)).toBe(0);

    const catalogHtml = await appPage(paths.appDetail(CATALOG));
    expect(markerOn(catalogHtml, paths.appDetail(CATALOG))).toBe(String(CATALOG_TOOLS.length));
    expect(markerOn(catalogHtml, paths.appPane(CATALOG, "prompts"))).toBe(String(CATALOG_PROMPTS.length));
    expect(markerOn(catalogHtml, paths.appPane(CATALOG, "resources"))).toBe(
      String(CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length),
    );
    expect(textOf(catalogHtml)).toContain("paper_fetch");
    expect(textOf(catalogHtml)).not.toContain(pinned(REFRESH_FAILED));
  });

  it(`§13 · a Tools row is the tool's name, the first line of its description and no args / N args, and its expanded block — the full description plus the Arguments table read off inputSchema — arrives in that same response, server-rendered, never a second request, beneath the pane's verbatim footer`, async () => {
    const text = textOf(await appPage(paths.appDetail(CATALOG)));
    expect(text).toContain("paper_fetch");
    expect(text).toContain(PAPER_SUMMARY);
    expect(text).toContain("3 args");
    expect(text).toContain("jobfeed_crawl");
    expect(text).toContain("no args");

    // The expanded block is in the SAME response: the second description line and the
    // Arguments table's own content, with the nested schema's property nowhere at all.
    expect(text).toContain(PAPER_DETAIL);
    // Each argument as ONE contiguous run — `textOf` turns every `</td><td>` into a single
    // space, so this ties a name to its type and its Required cell. Loose tokens would not:
    // "required" is a substring of §13's approval lines and "string" of PAPER_DETAIL, both
    // on this very render, so a table with the wrong columns would still pass.
    expect(text).toContain("doi string required");
    expect(text).toContain("force_refresh boolean optional · defaults to false");
    expect(text).toContain("options object optional");
    expect(text).not.toContain("depth");

    expect(text).toContain(pinned(TOOLS_FOOTER));

    // No second request exists, and no parameter selects a row: the same four names and
    // the same expanded content come back under a query the page never reads.
    const queried = textOf(await appPage(`${paths.appDetail(CATALOG)}?tool=paper_fetch`));
    for (const name of CATALOG_TOOL_NAMES) expect(queried).toContain(name);
    expect(queried).toContain(PAPER_DETAIL);
    expect(queried).toContain("optional · defaults to false");

    // §13 attaches the tunneled header line to the tunneled branch and gives the proxied
    // live fetch none.
    expect(textOf(await appPage(paths.appDetail(TUNNELAPP)))).toContain(pinned(TUNNELED_TOOLS_HEADER));
    expect(text).not.toContain(pinned(TUNNELED_TOOLS_HEADER));
  });

  it(`§13/§7 · the Tools pane is the owner's own unfiltered read: a tool no granted pattern reaches is listed all the same, beside the ones that are (§7 step 2 — owner → all tools)`, async () => {
    // "No agent reaches it" is grounded in the DOOR, not in the fixture: every agent's
    // own grants, run through the matcher the pipeline runs, deny both tools.
    const held = await grantsOnCatalog();
    expect(Object.keys(held).length).toBeGreaterThan(0);
    for (const [agent, entries] of Object.entries(held)) {
      for (const name of ["secret_push", "bad_schema"]) {
        expect(buildToolFilter(entries, CATALOG_ROLES).check(name, "tools"), `${agent} → ${name}`).toBe("deny");
      }
    }
    const text = textOf(await appPage(paths.appDetail(CATALOG)));
    for (const name of CATALOG_TOOL_NAMES) expect(text, name).toContain(name);
  });

  it(`§13/§20.3 · "Called by agents as <slug>_<tool>" and the reachability line the door's own matcher computes: a literal role and a pattern role each name their agents and the role in the sentence §13 pins, an agent holding no grant on this app is named by neither, and a tool no granted pattern matches renders "Reachable by no agent yet" (the twin)`, async () => {
    const text = textOf(await appPage(paths.appDetail(CATALOG)));
    const blocks = blocksOf(text, CATALOG_TOOL_NAMES);

    // §13's line 1 WITH its frame, per tool block: a bare aggregated name is also what the
    // fixture's own tool names look like, and dropping the prefix would leave that green.
    for (const name of ["paper_fetch", "jobfeed_crawl", "secret_push"]) {
      expect(blocks[name], name).toContain(`Called by agents as ${CATALOG}_${name}`);
    }

    // The SENTENCE FRAME of line 2, so a bare list of names cannot pass.
    for (const name of ["paper_fetch", "jobfeed_crawl"]) {
      expect(blocks[name], name).toContain("Reachable by");
      expect(blocks[name], name).toContain("· via");
    }
    expect(blocks.paper_fetch).toContain("reader-agent");
    // The ROLE half, behind the separator: a bare toContain("reader") is already implied by
    // the agent's own slug, so "· via" is the only place the role name can prove itself.
    expect(blocks.paper_fetch).toContain("· via reader");
    for (const named of ["crawl-agent", "mixed-agent", "crawler", "both"]) {
      expect(blocks.jobfeed_crawl, named).toContain(named);
    }

    // An agent granted only on another app is named by neither line — and the same slug
    // IS named on that other app's own tool, beside the built-in role it holds.
    expect(text).not.toContain("all-agent");
    const plainText = textOf(await appPage(paths.appDetail(PLAIN)));
    const plainBlock = blocksOf(plainText, [PLAIN_TOOLS[0].name])[PLAIN_TOOLS[0].name];
    expect(plainBlock).toContain("all-agent");
    expect(plainBlock).toContain("all");

    expect(blocks.secret_push).toContain(NO_AGENT_YET);
    expect(blocks.secret_push).not.toContain("· via");
    for (const agent of ["reader-agent", "crawl-agent", "mixed-agent"]) {
      expect(blocks.secret_push, agent).not.toContain(agent);
    }
  });

  it(`§13/§2 · the approval posture is "No approval required" where every reaching agent reaches in allow mode and "Approval required for <agent>" where one reaches only in approval mode — an agent holding an allow role and an approval role that both match the same tool is named by neither line's approval half (allow wins)`, async () => {
    const blocks = blocksOf(textOf(await appPage(paths.appDetail(CATALOG))), CATALOG_TOOL_NAMES);

    expect(blocks.paper_fetch).toContain(NO_APPROVAL);
    expect(blocks.paper_fetch).not.toContain(APPROVAL_REQUIRED);

    expect(blocks.jobfeed_crawl).toContain(APPROVAL_REQUIRED);
    expect(blocks.jobfeed_crawl).not.toContain(NO_APPROVAL);
    const sentence = approvalSentence(blocks.jobfeed_crawl);
    expect(sentence).toContain("crawl-agent");
    // mixed-agent holds `crawler:approval` AND `both:allow`, both matching this tool, so
    // the door answers allow and this half must not name it — while the reachability line
    // beside it still does, which is what keeps the absence non-vacuous.
    expect(sentence).not.toContain("mixed-agent");
    expect(blocks.jobfeed_crawl).toContain("mixed-agent");
  });

  it(`§13/§7 · the redaction line reads "No redacted fields" where nothing matches · it lists the writeOnly argument paths beside the redact and redact_results entries that match where something does, and a tool whose schema carries indirection the hub will not resolve reads "schema-unsound — approval-gated calls refuse, bodies are not recorded" (the twin)`, async () => {
    // Read through the door's own functions, never transcribed: §7's matching is what
    // decides that `secret_.*` reaches `secret_push`, and the fixture cannot quietly
    // become sound behind the indirection assertion.
    const registry = new Registry(env.DB);
    const app = await registry.getApp(detail.ns.owner.userId, CATALOG);
    if (app === null) throw new Error("the app-detail fixture's catalog app vanished");
    const marked = writeOnlyPaths(SECRET_SCHEMA);
    const configured = await registry.redactPathsFor(app, "secret_push", "args");
    const results = await registry.redactPathsFor(app, "secret_push", "results");
    expect(marked.length, "the writeOnly walk found nothing").toBeGreaterThan(0);
    expect(configured.length, "the redact map matched nothing").toBeGreaterThan(0);
    expect(results.length, "the redact_results map matched nothing").toBeGreaterThan(0);
    expect(validateSchemaIndirection(BAD_SCHEMA).length, "the unsound schema is sound").toBeGreaterThan(0);

    const blocks = blocksOf(textOf(await appPage(paths.appDetail(CATALOG))), CATALOG_TOOL_NAMES);
    for (const path of [...marked, ...configured, ...results]) {
      expect(blocks.secret_push, path).toContain(path);
    }
    expect(blocks.bad_schema).toContain(SCHEMA_UNSOUND);

    expect(blocks.paper_fetch).toContain(NO_REDACTED);
    for (const path of [...marked, ...configured, ...results]) {
      expect(blocks.paper_fetch, path).not.toContain(path);
    }
  });

  it(`§13 · /apps/<slug> gets the pill row too — the shell rule applies although only MobileSettings was drawn: on every one of the eight panes the pill navigation lists the same eight pane URLs in the same rail order, markerless`, async () => {
    const hrefs = appPaneHrefs(CATALOG);
    let walked = 0;
    for (const href of hrefs) {
      const html = await appPage(href);
      const rail = railEntries(html, APP_RAIL_NAV_LABEL);
      const pills = railEntries(html, APP_PILL_NAV_LABEL);
      expect(rail.map((entry) => entry.href), href).toEqual(hrefs);
      expect(pills.map((entry) => entry.href), href).toEqual(hrefs);
      // Markerless, held non-vacuous on this same render: every pill has a label, and the
      // rail beside it does carry markers.
      expect(pills.every((entry) => entry.marker === ""), href).toBe(true);
      expect(pills.every((entry) => entry.label !== ""), href).toBe(true);
      expect(rail.some((entry) => entry.marker !== ""), href).toBe(true);
      walked += 1;
    }
    expect(walked).toBe(8);
  });

  it(`§13 · a tunneled app's Tools pane is the DO's cached catalog: the tools it advertised on its last connect are listed under a numeric Tools marker while its socket is open, and are still listed, unchanged and still counted, after the socket closes and the header reads offline`, async () => {
    const slug = uniqueSlug("cached");
    const served = [
      { name: uniqueSlug("keep").replace(/-/g, "_"), description: "One.", inputSchema: { type: "object" } },
      { name: uniqueSlug("hold").replace(/-/g, "_"), description: "Two.", inputSchema: { type: "object" } },
    ];
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools: served });
    let closed = false;
    try {
      const online = await appPage(paths.appDetail(slug));
      for (const tool of served) expect(textOf(online)).toContain(tool.name);
      expect(markerOn(online, paths.appDetail(slug))).toBe(String(served.length));
      expect(textOf(online)).toMatch(/\bonline\b/);

      await close();
      closed = true;
      // An offline tunneled app can answer no live call, so a pane that dialled instead
      // of reading the DO's cache renders the empty state here.
      const offline = await appPage(paths.appDetail(slug));
      for (const tool of served) expect(textOf(offline)).toContain(tool.name);
      expect(markerOn(offline, paths.appDetail(slug))).toBe(String(served.length));
      expect(textOf(offline)).toMatch(/\boffline\b/);
    } finally {
      if (!closed) await close();
    }
  });

  it(`§20.5/§13 · a tunneled app that declared no tools dims Tools to — and its LANDING pane renders the tunneled empty state with tools substituted, verbatim · the prompts the same app did declare carry a count and list a row (the twin)`, async () => {
    const slug = uniqueSlug("quiet");
    const served = [{ name: uniqueSlug("only").replace(/-/g, "_"), description: "The one prompt." }];
    const close = await dialTunnel(slug, { capabilities: ["prompts"], prompts: served });
    try {
      const html = await appPage(paths.appDetail(slug));
      const landing = railEntries(html, APP_RAIL_NAV_LABEL).find(
        (entry) => entry.href === paths.appDetail(slug),
      );
      expect(landing?.marker).toBe(DIMMED_MARKER);
      // A dimmed entry stays a link.
      expect(landing?.href).toBe(paths.appDetail(slug));
      const text = textOf(html);
      for (const sentence of tunneledUndeclared("tools")) expect(text).toContain(pinned(sentence));
      expect(mentions(text, `${slug}_`)).toBe(0);

      // The twin, same app and same render: the family it DID declare is counted and listed.
      expect(markerOn(html, paths.appPane(slug, "prompts"))).toBe(String(served.length));
      expect(textOf(await appPage(paths.appPane(slug, "prompts")))).toContain(served[0].name);
    } finally {
      await close();
    }
  });

  it(`§20.6 · the Tools pane is the scoped endpoint's own listing and not a second read: tools/list posted to /<user>/mcp/<slug> with the owner's own bearer answers exactly the names the pane rendered and exactly the number its rail marker shows — for a tunneled app and for a proxied one`, async () => {
    const tunneled = uniqueSlug("paired");
    const served = [
      { name: uniqueSlug("alpha").replace(/-/g, "_"), description: "One.", inputSchema: { type: "object" } },
      { name: uniqueSlug("beta").replace(/-/g, "_"), description: "Two.", inputSchema: { type: "object" } },
    ];
    const close = await dialTunnel(tunneled, { capabilities: ["tools"], tools: served });
    try {
      const seen: string[][] = [];
      for (const [slug, names] of [
        [CATALOG, CATALOG_TOOL_NAMES],
        [tunneled, served.map((tool) => tool.name)],
      ] as const) {
        const html = await appPage(paths.appDetail(slug));
        const text = textOf(html);
        const rendered = names.filter((name) => text.includes(name));
        const marker = markerOn(html, paths.appDetail(slug));
        const answered = await scopedList(slug, "tools/list");
        const wire = new Set((answered.tools ?? []).map((tool) => tool.name));
        expect([...wire].sort(), slug).toEqual([...rendered].sort());
        expect(wire.size, slug).toBe(Number(marker));
        expect(wire.size, slug).toBeGreaterThan(0);
        seen.push([...wire].sort());
      }
      // Non-vacuity: one constant could not satisfy both apps.
      expect(seen[0]).not.toEqual(seen[1]);
    } finally {
      await close();
    }
  });

  it(`§13 · a proxied app whose upstream cannot be reached at all renders the unread state rather than an empty one: its App-group markers are blank — never — and never 0 — and its Tools pane lists no tool and says nothing about the app advertising none · the reachable proxied app beside it lists rows under numeric markers (the twin)`, async () => {
    // The precondition through the door itself, so the fixture cannot quietly become
    // reachable: a scoped listing for DOWN answers an error rather than a list.
    const answered = await scopedList(DOWN, "tools/list");
    expect(answered.tools, "the unreachable upstream answered a list").toBeUndefined();

    const html = await appPage(paths.appDetail(DOWN));
    for (const href of [paths.appDetail(DOWN), paths.appPane(DOWN, "prompts"), paths.appPane(DOWN, "resources")]) {
      expect(markerOn(html, href), href).toBe("");
      expect(markerOn(html, href), href).not.toBe(DIMMED_MARKER);
      expect(markerOn(html, href), href).not.toBe("0");
    }
    // No tool row, read structurally: every listed row draws its aggregated `<slug>_`
    // name, so the prefix's absence IS the absence of rows.
    const text = textOf(html);
    expect(mentions(text, `${DOWN}_`)).toBe(0);
    expect(text).not.toContain(pinned(proxiedOmits("tools")));

    const catalogHtml = await appPage(paths.appDetail(CATALOG));
    expect(markerOn(catalogHtml, paths.appDetail(CATALOG))).toBe(String(CATALOG_TOOLS.length));
    expect(markerOn(catalogHtml, paths.appPane(CATALOG, "prompts"))).toBe(String(CATALOG_PROMPTS.length));
    expect(markerOn(catalogHtml, paths.appPane(CATALOG, "resources"))).toBe(
      String(CATALOG_RESOURCES.length + CATALOG_TEMPLATES.length),
    );
    expect(textOf(catalogHtml)).toContain("paper_fetch");
    expect(textOf(catalogHtml)).toContain(`${CATALOG}_paper_fetch`);
  });
});

describe(`§13/§20 · /apps/<slug> — Prompts, Resources, Roles and Overview`, () => {
  beforeAll(withAppDetailWorld);

  it(`§13/§20.3 · the Prompts pane gives each prompt its name, description and declared arguments, the <slug>_<prompt> name, reachability over the role's PROMPT patterns alone — a tools-only role reaches no prompt — the fixed "Never approval-gated", and the redact entries matching the prompt's name`, async () => {
    // §7's own function decides which `redact` entry reaches this prompt name — the map
    // is family-blind (§20.3), so the page and this row read the same matcher.
    const registry = new Registry(env.DB);
    const app = await registry.getApp(detail.ns.owner.userId, CATALOG);
    if (app === null) throw new Error("the app-detail fixture's catalog app vanished");
    const redacted = await registry.redactPathsFor(app, "digest_daily", "args");
    expect(redacted.length, "the redact map matched no prompt").toBeGreaterThan(0);

    const text = textOf(await appPage(paths.appPane(CATALOG, "prompts")));
    const blocks = blocksOf(text, CATALOG_PROMPT_NAMES);
    for (const prompt of CATALOG_PROMPTS) {
      expect(blocks[prompt.name], prompt.name).toContain(prompt.description);
      expect(blocks[prompt.name], prompt.name).toContain(NEVER_GATED);
    }

    // The declared arguments, and the hub block §13 attaches to each row.
    expect(blocks.digest_daily).toContain("day");
    expect(blocks.digest_daily).toContain("Which day.");
    expect(blocks.digest_daily).toContain("required");
    expect(blocks.digest_daily).toContain(`${CATALOG}_digest_daily`);
    expect(blocks.digest_daily).toContain("Reachable by reader-agent · via reader");
    for (const path of redacted) expect(blocks.digest_daily, path).toContain(path);

    // The prompt no granted PROMPT pattern reaches — `reader`'s `digest_.*` misses it.
    expect(blocks.weekly_note).toContain(NO_AGENT_YET);

    // A tools-only role reaches no prompt: both agents holding one are named on the
    // Tools pane and on neither prompt here.
    const toolsText = textOf(await appPage(paths.appDetail(CATALOG)));
    for (const agent of ["crawl-agent", "mixed-agent"]) {
      expect(text, agent).not.toContain(agent);
      expect(toolsText, agent).toContain(agent);
    }

    // §13's "the same shape without a schema table": a prompt has no `inputSchema`, so
    // neither of the Tools table's own strings appears on this pane. Both carry their
    // allow-twin on the render above — a renamed column header would otherwise leave the
    // negative green while the property it stands for went unchecked (§9 rule 2).
    expect(toolsText).toMatch(/\bType\b/);
    expect(text).not.toContain("optional · defaults to");
    expect(text).not.toMatch(/\bType\b/);
  });

  it(`§20.2/§13 · the Resources pane's rows are URI / Name / Type with templates listed by their raw uriTemplate, reachability is matched against the URI and against that raw template and NEVER against the name, no redaction line is rendered, and the pane carries §20's two rules`, async () => {
    const resourcesUrl = paths.appPane(CATALOG, "resources");
    const resourcesText = textOf(await appPage(resourcesUrl));
    const templatesText = textOf(await appPage(`${resourcesUrl}?tab=templates`));

    const blocks = blocksOf(resourcesText, CATALOG_RESOURCE_URIS);
    for (const row of CATALOG_RESOURCES) {
      expect(blocks[row.uri], row.uri).toContain(row.name);
      expect(blocks[row.uri], row.uri).toContain(row.mimeType);
    }
    expect(blocks["news://feed/latest"]).toContain("Reachable by reader-agent · via reader");
    // The decoy: its NAME matches `reader`'s `news://feed/*` and its URI does not, and the
    // pane matched the URI — §20.2's rule, asserted as the bug it prevents. The trap is
    // armed through the DOOR's own matcher first: a fixture pattern that drifted to match
    // only the URI would disarm it silently and leave the negative passing for free.
    expect(
      buildToolFilter([{ role: "reader", mode: "allow" }], CATALOG_ROLES).check(
        CATALOG_RESOURCES[1].name,
        "resources",
      ),
      "the decoy's NAME no longer matches the granted pattern",
    ).not.toBe("deny");
    expect(blocks["news://archive/2021"]).toContain(NO_AGENT_YET);
    expect(blocks["news://archive/2021"]).not.toContain("reader-agent");

    // The template listed by its RAW uriTemplate, braces intact, reached because `*`
    // aliases `.*` over that same string (§20.3 — the hub never expands a template).
    const template = blocksOf(templatesText, CATALOG_TEMPLATE_URIS)[CATALOG_TEMPLATE_URIS[0]];
    expect(template).toContain(CATALOG_TEMPLATES[0].name);
    expect(template).toContain("Reachable by reader-agent · via reader");

    // No redaction line on either tab — URIs are not bodies (§13). The Tools pane next
    // door renders both halves on the same app, which is what makes the absence a claim.
    const registry = new Registry(env.DB);
    const app = await registry.getApp(detail.ns.owner.userId, CATALOG);
    if (app === null) throw new Error("the app-detail fixture's catalog app vanished");
    const toolPaths = [
      ...(await registry.redactPathsFor(app, "secret_push", "args")),
      ...(await registry.redactPathsFor(app, "secret_push", "results")),
    ];
    const promptPaths = await registry.redactPathsFor(app, "digest_daily", "args");
    expect([...toolPaths, ...promptPaths].length, "the redact maps matched nothing").toBeGreaterThan(0);
    for (const text of [resourcesText, templatesText]) {
      expect(text).not.toContain(NO_REDACTED);
      for (const path of [...toolPaths, ...promptPaths]) expect(text, path).not.toContain(path);
    }
    // Each absent path is named on the pane whose family the `redact` entry matched, so
    // no half of the absence can be passing because nothing renders it anywhere.
    const toolsText = textOf(await appPage(paths.appDetail(CATALOG)));
    expect(toolsText).toContain(NO_REDACTED);
    for (const path of toolPaths) expect(toolsText, path).toContain(path);
    const promptsText = textOf(await appPage(paths.appPane(CATALOG, "prompts")));
    for (const path of promptPaths) expect(promptsText, path).toContain(path);

    // §20's two rules, verbatim, on both tabs — with the endpoint the first one names.
    for (const text of [resourcesText, templatesText]) {
      expect(text).toContain(SCOPED_ONLY_HEAD);
      expect(text).toContain(pinned(SCOPED_ONLY_TAIL));
      expect(text).toContain(pinned(URI_NOT_NAME));
      expect(text).toContain(paths.mcpScoped(detail.ns.owner.username, CATALOG));
    }
  });

  it(`§13/§20.1 · completion/complete gets no pane: the rail names no completions entry and /apps/<slug>/completions is a 404 · the seven pane URLs the table does name each answer 200 (the twin)`, async () => {
    const rail = railEntries(await appPage(paths.appDetail(CATALOG)), APP_RAIL_NAV_LABEL);
    expect(rail.filter((entry) => entry.href.endsWith("/completions"))).toEqual([]);
    expect(rail.filter((entry) => entry.label.includes("Completion"))).toEqual([]);

    // A family that gets no pane is indistinguishable from a segment naming nothing.
    const missing = await get(`${paths.appDetail(CATALOG)}/completions`, detail.session.cookie);
    const nonsense = await get(`${paths.appDetail(CATALOG)}/${uniqueSlug("nope")}`, detail.session.cookie);
    expect(missing.status, "GET /apps/<slug>/completions").toBe(404);
    expect(nonsense.status).toBe(404);
    expect(await missing.text()).toBe(await nonsense.text());

    // The twin, in the same fixture: the seven the table DOES name each answer 200.
    for (const href of appPaneHrefs(CATALOG).slice(1)) {
      expect((await get(href, detail.session.cookie)).status, href).toBe(200);
    }
  });

  it(`§13/§20.3 · the Roles pane renders the declared roles in §20.3's canonical read shape under its kind's own sentence — tunneled adds the trust-boundary line, proxied says roles are config — and an app that declared none renders "No roles declared" beside the built-in-all fallback with none on its rail entry (the twin)`, async () => {
    const tunnelHtml = await appPage(paths.appPane(TUNNELAPP, "roles"));
    const tunnelText = textOf(tunnelHtml);
    expect(tunnelText).toContain(ROLES_TUNNELED);
    expect(tunnelText).toContain(ROLES_TRUST);
    expect(tunnelText).not.toContain(ROLES_PROXIED);
    expect(tunnelText).toContain("reader");
    expect(tunnelText).toContain("get_.*");
    expect(markerOn(tunnelHtml, paths.appPane(TUNNELAPP, "roles"))).toBe("1");

    const catalogHtml = await appPage(paths.appPane(CATALOG, "roles"));
    const catalogText = textOf(catalogHtml);
    expect(catalogText).toContain(ROLES_PROXIED);
    expect(catalogText).not.toContain(ROLES_TUNNELED);
    expect(catalogText).not.toContain(ROLES_TRUST);
    expect(markerOn(catalogHtml, paths.appPane(CATALOG, "roles"))).toBe(
      String(Object.keys(CATALOG_ROLES).length),
    );

    // §20.3's canonical read shape has TWO directions, and both are on this one page:
    // `app_get` hands back a bare list for the tools-only role and the per-family object
    // for the other, so a pane that always spelled one of them fails here.
    const roles = (await appRowOf(CATALOG)).roles;
    expect(Array.isArray(roles.crawler), "crawler is not canonicalized to a bare list").toBe(true);
    expect(Array.isArray(roles.reader), "reader is not canonicalized to a family object").toBe(false);
    const blocks = blocksOf(catalogText, Object.keys(CATALOG_ROLES));
    expect(blocks.crawler).toContain("jobfeed_.*");
    for (const family of ["tools", "prompts", "resources"]) {
      expect(blocks.reader, family).toContain(family);
      expect(blocks.crawler, family).not.toContain(family);
    }

    // The twin: an app that declared none says so, and its marker is the literal `none`
    // §13's table spells — not "0", and not the dimmed em dash a family earns.
    const freshHtml = await appPage(paths.appPane(FRESHAPP, "roles"));
    const freshText = textOf(freshHtml);
    expect(freshText).toContain(ROLES_NONE);
    expect(freshText).toContain(pinned(ROLES_FALLBACK));
    expect(markerOn(freshHtml, paths.appPane(FRESHAPP, "roles"))).toBe("none");
  });

  it(`§13/§8 · the Overview pane is app_get's row as a definition list — slug, created, kind, and a proxied app's endpoint, auth mode and forward identity — with body logging reading "On — tunneled default" / "Off — proxied default" at each kind's default, neither string where the owner set it explicitly, and none where no redaction is configured`, async () => {
    // Every value is compared against §8's OWN row rather than against a transcription,
    // so the op's shape and the pane cannot drift apart unnoticed.
    const catalogRow = await appRowOf(CATALOG);
    const catalogText = textOf(await appPage(paths.appPane(CATALOG, "overview")));
    expect(catalogText).toContain(CATALOG);
    expect(catalogText).toMatch(/\bproxy\b/);
    expect(catalogText).toContain(String(catalogRow.endpoint));
    expect(catalogText).toMatch(/\bheaders\b/);
    // The three proxied-only LABELS, each the allow-twin of a negative below: the header's
    // upstream card draws no rows on this pane, so nothing else claims them (§9 rule 2).
    expect(catalogText).toContain("Endpoint");
    expect(catalogText).toMatch(/\bAuth\b/);
    expect(catalogText).toContain("Forward identity");
    expect(catalogText).toContain(LOG_BODIES_PROXY);
    // Created renders a value beside its label; its FORMAT is incidental (§7).
    const head = blocksOf(catalogText, ["Slug", "Created", "Kind"]);
    expect(head.Created.replace("Created", "").trim()).not.toBe("");

    const tunnelText = textOf(await appPage(paths.appPane(TUNNELAPP, "overview")));
    expect(tunnelText).toMatch(/\btunnel\b/);
    expect(tunnelText).toContain(LOG_BODIES_TUNNEL);
    // The three proxied-only rows are absent on a tunneled app — and so is the header's
    // upstream card, which is why "Forward identity" is readable as this pane's own.
    expect(tunnelText).not.toContain("Forward identity");
    expect(tunnelText).not.toContain("Endpoint");
    // `Auth` on its own boundary: a tunneled Overview leaking the row with an empty value
    // is exactly what §13's "for proxied apps" refuses.
    expect(tunnelText).not.toMatch(/\bAuth\b/);

    // The owner set it explicitly against its kind's default, so naming a default here
    // would be false — and the label still renders, which is what keeps this non-vacuous.
    const freshText = textOf(await appPage(paths.appPane(FRESHAPP, "overview")));
    expect(freshText).toContain("Body logging");
    expect(freshText).not.toContain(LOG_BODIES_TUNNEL);
    expect(freshText).not.toContain(LOG_BODIES_PROXY);

    // Redaction: `none` where nothing is configured, the config paths where something is.
    const tunnelRow = await appRowOf(TUNNELAPP);
    expect(Object.keys(tunnelRow.redact), "the tunneled fixture configures redaction").toEqual([]);
    const tunnelBlocks = blocksOf(tunnelText, ["Redacted arguments", "Redacted results"]);
    expect(tunnelBlocks["Redacted arguments"]).toContain("none");
    expect(tunnelBlocks["Redacted results"]).toContain("none");
    const catalogBlocks = blocksOf(catalogText, ["Redacted arguments", "Redacted results"]);
    expect(catalogBlocks["Redacted arguments"]).not.toContain("none");
    for (const path of Object.values(catalogRow.redact).flat()) {
      expect(catalogBlocks["Redacted arguments"], path).toContain(path);
    }
    for (const path of Object.values(catalogRow.redactResults).flat()) {
      expect(catalogBlocks["Redacted results"], path).toContain(path);
    }

    // The definition list belongs to THIS pane: the one beside it draws none of it.
    expect(textOf(await appPage(paths.appPane(CATALOG, "roles")))).not.toContain("Body logging");
  });

  it(`§13 · the five App-group panes edit nothing: Tools, Prompts, Resources, Roles and Overview render no mutating form of any kind · the same page's header and Danger zone do (the twin)`, async () => {
    // §13's "The page edits nothing here." and Roles' "read-only", as the negative half of
    // this page's §9 rule 4a partition. The three targets allowed are not the pane's: two
    // are the header's own controls (§13 gives them to every pane of an `auth: oauth` app)
    // and one is the shell's Sign out, which layout.tsx renders into every signed-in page.
    const appGroup = (slug: string): string[] => [
      paths.appDetail(slug),
      ...(["prompts", "resources", "roles", "overview"] as const).map((pane) =>
        paths.appPane(slug, pane),
      ),
    ];
    const found = new Set<string>();
    for (const slug of [CATALOG, BROKEN]) {
      // The allowance is the PAGE'S OWN, per slug: merged across both apps it would let a
      // pane of one app post at the other app's Connect target.
      const allowed = [paths.auth.signOut, paths.appConnect(slug), paths.appDisconnect(slug)];
      for (const url of appGroup(slug)) {
        const html = await appPage(url);
        for (const action of formsOn(html)) {
          expect(allowed, `${url} posts to ${action}`).toContain(action);
          found.add(action);
        }
        // And none of them names an admin.ops key beyond the header's own.
        for (const op of opsOn(html)) {
          expect(["connect", "app_disconnect", "sign-out"], `${url} fronts ${op}`).toContain(op);
        }
      }
    }
    // BROKEN's header really drew its controls, so the walk above was not over five pages
    // with nothing on them at all.
    expect([...found]).toContain(paths.appConnect(BROKEN));

    // THE TWIN: the Token pane and the Danger zone between them DO edit, so the negative
    // above is not a claim about pages with no forms anywhere. The archive half stays on
    // BROKEN — the app the walk covered — while the Token half MUST move to a tunneled app:
    // a proxied app's Token pane draws prose and no control ("the hub dials the upstream;
    // nothing dials in", §13/§2), so there is no token form on BROKEN to find.
    const editing = new Set([
      ...opsOn(await appPage(paths.appPane(TUNNELAPP, "token"))),
      ...opsOn(await appPage(paths.appConfirm(BROKEN, "danger", "archive"))),
    ]);
    expect([...editing]).toContain("token_issue");
    expect([...editing]).toContain("app_archive");
  });

  it(`§13 · the Resources pane draws the three column names §13 spells — URI / Name / Type — on both of its tabs, beside the rows they head`, async () => {
    const resourcesUrl = paths.appPane(CATALOG, "resources");
    for (const [url, listed] of [
      [resourcesUrl, CATALOG_RESOURCE_URIS],
      [`${resourcesUrl}?tab=templates`, CATALOG_TEMPLATE_URIS],
    ] as const) {
      const text = textOf(await appPage(url));
      // The §20 rules block alone carries three capitalised, word-bounded URIs, so a pane
      // with no header at all would satisfy `\bURI\b` against the unsubtracted text.
      const stripped = [SCOPED_ONLY_HEAD, SCOPED_ONLY_TAIL, URI_NOT_NAME].reduce(
        (rest, rule) => rest.replace(pinned(rule), ""),
        text,
      );
      expect(stripped, url).toMatch(/\bURI\b/);
      // Case-sensitive: the rules' own "never by name" cannot satisfy `\bName\b`, and
      // `mimeType` carries no word boundary before its `Type`.
      expect(text, url).toMatch(/\bName\b/);
      expect(text, url).toMatch(/\bType\b/);
      // The rows they head are on this same render, so no header is claimed over an
      // empty tab.
      for (const uri of listed) expect(text, uri).toContain(uri);
    }
  });

  it(`§20.6/§20.2 · the aggregated name is tools and prompts only: neither Resources tab renders a <slug>_ name anywhere · the Prompts pane next door renders one and the Tools pane another (the twin)`, async () => {
    const resourcesUrl = paths.appPane(CATALOG, "resources");
    // Over TEXT, never raw html: an `id="<slug>_resources"` is markup the spec says
    // nothing about (§7), and a raw check would go red on one.
    for (const url of [resourcesUrl, `${resourcesUrl}?tab=templates`]) {
      expect(textOf(await appPage(url)), url).not.toContain(`${CATALOG}_`);
    }
    // The twin, so the absence is about this pane rather than about the whole convention.
    expect(textOf(await appPage(paths.appPane(CATALOG, "prompts")))).toContain(`${CATALOG}_digest_daily`);
    expect(textOf(await appPage(paths.appDetail(CATALOG)))).toContain(`${CATALOG}_paper_fetch`);
  });

  it(`§20.6 · the Prompts and Resources panes are the scoped endpoint's own listings too — prompts/list, resources/list and resources/templates/list under the owner's own bearer answer exactly the names each pane rendered, exactly the count each tab shows, and the Resources rail marker is those two counts summed`, async () => {
    const promptsUrl = paths.appPane(CATALOG, "prompts");
    const promptsHtml = await appPage(promptsUrl);
    const rendered = new Set(CATALOG_PROMPT_NAMES.filter((name) => textOf(promptsHtml).includes(name)));
    const wirePrompts = new Set(((await scopedList(CATALOG, "prompts/list")).prompts ?? []).map((p) => p.name));
    expect([...wirePrompts].sort()).toEqual([...rendered].sort());
    expect(wirePrompts.size).toBe(Number(markerOn(promptsHtml, promptsUrl)));

    const resourcesUrl = paths.appPane(CATALOG, "resources");
    const templatesUrl = `${resourcesUrl}?tab=templates`;
    const resourcesHtml = await appPage(resourcesUrl);
    const templatesHtml = await appPage(templatesUrl);
    const shownResources = new Set(CATALOG_RESOURCE_URIS.filter((uri) => textOf(resourcesHtml).includes(uri)));
    const shownTemplates = new Set(CATALOG_TEMPLATE_URIS.filter((uri) => textOf(templatesHtml).includes(uri)));
    const wireResources = new Set(
      ((await scopedList(CATALOG, "resources/list")).resources ?? []).map((row) => row.uri ?? ""),
    );
    const wireTemplates = new Set(
      ((await scopedList(CATALOG, "resources/templates/list")).resourceTemplates ?? []).map(
        (row) => row.uriTemplate ?? "",
      ),
    );
    expect([...wireResources].sort()).toEqual([...shownResources].sort());
    expect([...wireTemplates].sort()).toEqual([...shownTemplates].sort());
    expect(linkTexts(resourcesHtml, resourcesUrl)).toContain(`Resources ${wireResources.size}`);
    expect(linkTexts(resourcesHtml, templatesUrl)).toEqual([`Templates ${wireTemplates.size}`]);
    // The claim a per-tab equality cannot make: one rail marker over two listings.
    expect(markerOn(resourcesHtml, resourcesUrl)).toBe(String(wireResources.size + wireTemplates.size));

    // Non-vacuity: three non-empty answers, and the two resource sets disjoint, so one
    // listing cannot be satisfying both tabs.
    for (const answered of [wirePrompts, wireResources, wireTemplates]) {
      expect(answered.size).toBeGreaterThan(0);
    }
    expect([...wireResources].filter((uri) => wireTemplates.has(uri))).toEqual([]);
  });
});


/* ------------------------------------------------------------------ *
 * /apps/<slug> — the Access group, the Danger zone, and the refusals
 * ------------------------------------------------------------------ */

/** §13's pinned sentences for the three panes below, each byte-identical with the spec
 *  (the backticked ones go through `pinned`; none of these carries a code span). */
const AGENTS_FOOTER = "Grants are edited per agent × app pair — saving replaces that pair's whole set.";
const PROXIED_NO_TOKENS = "Proxied apps hold no tokens — the hub dials the upstream; nothing dials in (§2).";
const REVOKE_CLOSES = "Revoking closes the app's live connection.";
const ISSUE_ROTATION = "The previous token keeps working until you revoke it.";
const ARCHIVE_SENTENCE = "It refuses connections and leaves the list — tokens, grants and history are kept.";
const DELETE_SENTENCE =
  "Revokes its tokens, closes the live connection and removes every grant. This cannot be undone.";
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

describe(`§13 · /apps/<slug> — Agents, Token and the Danger zone`, () => {
  beforeAll(withAppDetailWorld);
  beforeAll(async () => {
    access = await seedAccessWorld();
  });

  it(`§13 · /apps/<slug>/access lists exactly the agents holding ≥1 grant on this app, read from agent_list's inline grants, and the rail's Agents marker is the number of rows it drew · an agent granted only on another app is absent here and present on that app's own pane (the twin)`, async () => {
    // Ground truth from the op, so the absence below is FILTERING rather than an empty
    // namespace: all three agents exist and all three are listed by agent_list.
    const listed = (await ops.agent_list.handler(access.ownerId, {})) as { agents: { slug: string }[] };
    const known = listed.agents.map((agent) => agent.slug);
    for (const slug of Object.values(ACCESS_SLUG)) expect(known, slug).toContain(slug);

    const alphaPane = paths.appPane(ALPHA, "access");
    const alphaHtml = await page(alphaPane, access.cookie);
    const alpha = textOf(alphaHtml);
    expect(alpha).toContain(ACCESS_SLUG.claude);
    expect(alpha).toContain(ACCESS_SLUG.pi);
    expect(alpha).not.toContain(ACCESS_SLUG.stray);
    expect(markerOn(alphaHtml, alphaPane)).toBe("2");

    // One agent_list, two panes, two answers — the twin.
    const betaPane = paths.appPane(BETA, "access");
    const betaHtml = await page(betaPane, access.cookie);
    const beta = textOf(betaHtml);
    expect(beta).toContain(ACCESS_SLUG.stray);
    expect(beta).not.toContain(ACCESS_SLUG.claude);
    expect(beta).not.toContain(ACCESS_SLUG.pi);
    expect(markerOn(betaHtml, betaPane)).toBe("1");
  });

  it(`§13 · an Agents row is the agent's slug and description as text — no link to the deferred /agents/<slug> — one role · mode chip per grant with the built-in all marked built-in, and the pane renders no Edit grants control beside the rows it does render (deferred, §13), under its verbatim footer`, async () => {
    const html = await page(paths.appPane(ALPHA, "access"), access.cookie);
    const text = textOf(html);
    for (const handle of ["claude", "pi"] as const) {
      expect(ACCESS_NAME[handle], "the fixture's name must differ from its slug").not.toBe(
        ACCESS_SLUG[handle],
      );
      expect(text, handle).toContain(ACCESS_SLUG[handle]);
      expect(text, handle).toContain(ACCESS_DESCRIPTION[handle]);
    }
    // The chips in §13's own spelling: one per grant, the built-in `all` marked.
    expect(text).toContain("all · allow");
    expect(text).toContain("built-in");
    expect(text).toContain("reader · approval");

    // Non-vacuity of the marking WITHOUT counting occurrences — beta's only agent holds
    // `reader` alone, so the word must not be on that pane at all.
    const betaHtml = await page(paths.appPane(BETA, "access"), access.cookie);
    const beta = textOf(betaHtml);
    expect(beta).toContain("reader · allow");
    expect(beta).not.toContain("built-in");

    // Slugs are TEXT: `/agents/<slug>` is deferred, so a link there would be a link to a
    // 404 — on EITHER page, which is why beta's markup is kept rather than only its text.
    for (const rendered of [html, betaHtml]) {
      for (const attribute of rendered.matchAll(/href="([^"]*)"/g)) {
        expect(decodeEntities(attribute[1]).startsWith("/agents/"), attribute[1]).toBe(false);
      }
    }

    // No editor, and the absence is the PAGE's choice: `grant_set` is a real op.
    expect(Object.keys(ops)).toContain("grant_set");
    expect(formsRenderedOn(html).map((form) => form.op)).not.toContain("grant_set");
    expect(text).not.toContain("Edit grants");
    expect(text).toContain(AGENTS_FOOTER);
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

  it(`§13 · Revoke on /apps/<slug>/token walks end to end as a browser walks it — the confirm link, the dialog carrying "Revoking closes the app's live connection.", the posted form, the redirect back to the token pane — and the key stops authenticating a tunnel while the app's other live key still does (the twin)`, async () => {
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
    expect(textOf(dialog)).toContain(REVOKE_CLOSES);
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
    expect(textOf(dialog)).toContain(DELETE_SENTENCE);
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
    ];
    const seen = new Set<string>();
    for (const url of walked) {
      for (const form of formsRenderedOn(await page(url, cookie))) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) {
          expect(BROWSER_ONLY_TARGETS.has(form.op), `${url} → ${form.op}`).toBe(true);
          continue;
        }
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
    // Non-vacuity: the walk really saw this page's five ops. `connect` is not among them —
    // it is a browser-only target (§19's redirect), and BROWSER_ONLY_TARGETS holds it.
    for (const op of ["token_issue", "token_revoke", "app_archive", "app_delete", "app_disconnect"]) {
      expect([...seen], op).toContain(op);
    }
  });

  it(`§13 · the Agents pane draws the two column names §13 spells — Agent and Granted roles — over the rows they head · the same render carries the slugs, descriptions and role · mode chips those columns describe (the twin)`, async () => {
    // No header is checked against an empty pane: the op says at least one agent holds a
    // grant on alpha before anything is read off the render.
    const listed = (await ops.agent_list.handler(access.ownerId, {})) as {
      agents: { slug: string; grants: Record<string, string[]> }[];
    };
    const holders = listed.agents.filter((agent) => (agent.grants[ALPHA] ?? []).length > 0);
    expect(holders.length).toBeGreaterThan(0);

    const text = textOf(await page(paths.appPane(ALPHA, "access"), access.cookie));
    // The word boundary is load-bearing: the rail entry reads `Agents` and the footer says
    // "per agent × app pair".
    expect(text).toMatch(/\bAgent\b/);
    expect(text).toContain("Granted roles");

    // The twin, on the same render — the rows those columns head.
    for (const agent of holders) expect(text, agent.slug).toContain(agent.slug);
    for (const handle of ["claude", "pi"] as const) expect(text).toContain(ACCESS_DESCRIPTION[handle]);
    expect(text).toContain("all · allow");
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

  it(`§13 · an archived app's page keeps its catalog: after Archive is posted from the danger pane the banner page still lists the tools the app advertised and its Tools marker is still that number · the same page listed them under the same marker before the archive (the twin)`, async () => {
    const slug = uniqueSlug("kept");
    const tools = [
      { name: uniqueSlug("kept").replace(/-/g, "_"), description: "One.", inputSchema: { type: "object" } },
      { name: uniqueSlug("held").replace(/-/g, "_"), description: "Two.", inputSchema: { type: "object" } },
    ];
    // `close()` first, so nothing below depends on the socket staying open.
    const close = await dialTunnel(slug, { capabilities: ["tools"], tools });
    await close();

    // BEFORE — the twin, and what makes "still" mean anything.
    const landing = paths.appDetail(slug);
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
    expect(seen).toBe(8);
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
    expect(seen).toBe(8);

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

/** The ?session=… link the expanded row detail renders. */
function sessionLink(html: string): string | null {
  const link = /href="(\/audit\?[^"]*session=[^"]*)"/.exec(html);
  return link === null ? null : decodeEntities(link[1]);
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
  return [...new Set(formsRenderedOn(html).map((form) => form.op))].sort();
}

/** Strictly more, as a set: everything `fewer` has, plus at least one it does not. A page
 *  that renders an op inline AND behind a dialog therefore cannot fail for the wrong
 *  reason, which a set DIFFERENCE would make it do. */
function supersets(more: string[], fewer: string[]): boolean {
  return fewer.every((op) => more.includes(op)) && more.length > fewer.length;
}

/** Every posting form's action on one rendered page, sorted — the shape "this query drew a
 *  form the bare pane does not" is compared as. */
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
 */
async function plantPasskey(
  userId: string,
  fields: { name: string; createdAt?: string; credentialId?: string },
): Promise<string> {
  const id = uniqueSlug("pk");
  await (env.DB as D1Like)
    .prepare(
      `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt")
       VALUES (?, ?, 'pk', ?, ?, 0, 'singleDevice', 0, ?)`,
    )
    .bind(
      id,
      fields.name,
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

/** §13's approval line out of one tool's block. It is the third of four hub lines, so it
 *  runs from its own opening to whichever line follows — which is how "that agent is not
 *  named in THAT sentence" is asserted about the sentence and not about the block. */
function approvalSentence(block: string): string {
  const at = block.indexOf(APPROVAL_REQUIRED);
  if (at < 0) return "";
  const rest = block.slice(at + APPROVAL_REQUIRED.length);
  const ends = [NO_REDACTED, "Redacted ", SCHEMA_UNSOUND]
    .map((end) => rest.indexOf(end))
    .filter((found) => found >= 0);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
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
    tools?: { name: string }[];
    prompts?: { name: string }[];
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
    else if (frame.method === "resources/list") answer({ result: { resources: [] } });
    else if (frame.method === "resources/templates/list") answer({ result: { resourceTemplates: [] } });
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
