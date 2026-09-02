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
import { Approvals } from "../../src/approvals";
import { query, record } from "../../src/audit";
import type { AuditQuery, AuditRow } from "../../src/audit";
import { requireOwnerSession } from "../../src/identity";
import worker from "../../src/index";
import type { Env } from "../../src/index";
import { paths } from "../../src/pages/model";
import { tokenPattern } from "../../src/principal";
import { Registry } from "../../src/registry";
import type { App } from "../../src/registry";
import { beginConnect } from "../../src/upstream";
import { upstreamUrlFor } from "../harness/fake-upstream";
import type { AsScenario, UpstreamScenario } from "../harness/fake-upstream";
import { seedNamespace, seedOwnerCredential, seedOwnerSession, SEEDED_OWNER_PASSWORD, uniqueSlug } from "../harness/seed";
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

/** One rendered form as a browser would submit it untouched: every named control under the
 *  value the page put there — hidden fields carry real ones (the CSRF token, the redirect
 *  target, a row id) and typed fields carry "". */
function submissionOf(body: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const control of body.matchAll(/<input\b([^>]*)>/g)) {
    const name = attributeOf(control[1], "name");
    if (name === null) continue;
    fields[name] = decodeEntities(attributeOf(control[1], "value") ?? "");
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
async function ageSession(token: string): Promise<void> {
  await (env.DB as D1Like)
    .prepare(`UPDATE "session" SET "createdAt" = ? WHERE "token" = ?`)
    .bind(new Date(Date.now() - AGED_SESSION_MS).toISOString(), token)
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

/** Every page that renders a credential form — /login's three cards, the signed-in shell's
 *  Sign out, /settings's two-factor controls, and the destructive confirm dialog. */
async function credentialPages(cookie: string): Promise<string[]> {
  return [
    await anonymousPage(paths.login),
    await anonymousPage(`${paths.login}?step=totp`),
    await anonymousPage(`${paths.login}?step=backup-code`),
    await page(paths.apps, cookie),
    await page(paths.settings, cookie),
    await page(paths.settingsConfirm("disable-two-factor"), cookie),
  ];
}

/** The confirm link /settings renders beside one session's Revoke button, or null when it
 *  rendered none — built from `paths` so the page and the walk cannot spell it differently. */
function revokeLinkFor(html: string, sessionId: string): string | null {
  const link = paths.settingsConfirm("revoke-session", sessionId);
  return html.includes(link.replace(/&/g, "&amp;")) ? link : null;
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

  it("18. §8 · /settings renders no ops-backed form at all — the pinned parity exception: credentials ride better-auth's endpoints and are never reachable from a pmcp tool", async () => {
    const forms = formsRenderedOn(await page(paths.settings));
    expect(forms.length, "/settings rendered no form to check").toBeGreaterThan(0);
    for (const form of forms) {
      expect(Object.prototype.hasOwnProperty.call(ops, form.op), `/settings fronts "${form.op}"`).toBe(false);
    }
    // Every one of them posts to better-auth's mount instead, which is the exception
    // stated as a positive rather than as an absence.
    for (const form of formsRenderedOn(await page(paths.settings))) {
      expect(BETTER_AUTH_ACTIONS.has(form.op), `/settings fronts "${form.op}"`).toBe(true);
    }
  });

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
    // A session of this case's own: `sign-out` is one of the walked targets, and a
    // successful one would end the session every other post in the walk rides.
    const walker = await seedOwnerSession(world.ns.owner);
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
    // Sign out last, for the reason above.
    const walk = [...targets].sort(
      ([a], [b]) => Number(a === paths.auth.signOut) - Number(b === paths.auth.signOut),
    );
    for (const [action, fields] of walk) {
      const answered = await formPost(action, fields, walker.cookie);
      expect(answered.status, `POST ${action}`).not.toBe(415);
      expect(answered.status, `POST ${action}`).not.toBe(404);
      expect(answered.status, `POST ${action}`).toBeLessThan(500);
    }
  });

  it("25. §4 · /settings's Revoke walks end to end as a browser walks it — the confirm link, the rendered form, the form-encoded POST — and the session it named is gone from the listing afterwards while the current one stays", async () => {
    const doomed = await seedOwnerSession(world.ns.owner);
    // Resolved BEFORE the revoke: afterwards the cookie names no session, which is the
    // postcondition rather than a way to ask for the id.
    const doomedId = await sessionIdOf(doomed.cookie);
    const listed = await page(paths.settings);
    const confirm = revokeLinkFor(listed, doomedId);
    expect(confirm, "/settings rendered no revoke link for the second session").not.toBeNull();
    const dialog = await page(confirm ?? "");
    const answered = await formPost(
      actionFor(dialog, "revoke-session"),
      submissionOf(dialog),
      world.session.cookie,
    );
    expect(answered.status).toBe(303);
    // The redirect-back flash says which it was, so a refusal fails HERE with its reason
    // rather than three lines later as an unexplained listing.
    expect(answered.headers.get("Location")).toContain("done=");
    const after = await page(paths.settings);
    expect(after).not.toContain(doomedId);
    // The twin: the revoke took one session, not the listing — the current one is still
    // here and still opens the page, while the revoked cookie is now nobody's.
    expect(after).toContain("current");
    expect((await get(paths.settings, doomed.cookie)).status).toBe(302);
  });

  it("25a. §13 · /settings lists the owner's passkeys from the plugin's own listing, and Remove walks end to end as a browser walks it — the confirm link, the dialog naming the passkey, the form-encoded POST — and the row is gone afterwards, while a guessed id draws no dialog", async () => {
    const id = uniqueSlug("pk");
    // A registration's row, minus the ceremony: no test can perform WebAuthn, so the row
    // is written the way the plugin would write it (its columns, ISO dates) and everything
    // asserted after goes through the page's own links, forms and the real route.
    await (env.DB as D1Like)
      .prepare(
        `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt")
         VALUES (?, ?, 'pk', ?, ?, 0, 'singleDevice', 0, ?)`,
      )
      .bind(id, "MacBook Touch ID", world.ns.owner.userId, uniqueSlug("cred"), new Date().toISOString())
      .run();
    const confirm = paths.settingsConfirm("remove-passkey", id);
    const listed = await page(paths.settings);
    expect(listed).toContain("MacBook Touch ID");
    expect(listed).toContain(confirm.replace(/&/g, "&amp;"));
    // The twin: a confirm naming no row on the page is no dialog at all.
    expect(await page(paths.settingsConfirm("remove-passkey", uniqueSlug("nope")))).not.toContain("Remove passkey");
    const dialog = await page(confirm);
    expect(dialog).toContain("Remove passkey");
    const answered = await formPost(actionFor(dialog, "delete-passkey"), submissionOf(dialog), world.session.cookie);
    expect(answered.status).toBe(303);
    expect(answered.headers.get("Location")).toContain("done=");
    expect(await page(paths.settings)).not.toContain("MacBook Touch ID");
  });

  it("26. §4 · a browser session past better-auth's freshness window can post NONE of /settings's credential targets — the recent-auth gate sits on the mutations, not only on the read (the actor is a day-old cookie carrying its own real CSRF token)", async () => {
    // A namespace of this case's own: two sign-ins for one owner, one of them aged, so
    // ageing one session cannot age the twin it is being compared against. It holds a
    // app because /apps is where both tokens below are read from, and a namespace
    // with nothing in it renders no mutating form to read one off.
    const owner = await seedNamespace(env.DB, { apps: [{ slug: "news", kind: "tunnel" }] });
    const stale = await seedOwnerSession(owner.owner);
    await ageSession(stale.token);
    const fresh = await seedOwnerSession(owner.owner);
    // Each session's OWN token, taken off a page it can still render (/apps carries no
    // recency gate). Without it the refusal below could be the CSRF check answering, and
    // the case would pass against a hub that never looked at the session's age at all.
    const staleCsrf = csrfOf(await page(paths.apps, stale.cookie));
    const freshCsrf = csrfOf(await page(paths.apps, fresh.cookie));
    // The read is already gated; it is here as the answer every mutation must match.
    const read = await get(paths.settings, stale.cookie);
    expect(read.status).toBe(302);
    expect(read.headers.get("Location")).toMatch(/^\/login(\?|$)/);

    expect(SETTINGS_CREDENTIAL_TARGETS.length, "no credential target to walk").toBeGreaterThan(0);
    for (const target of SETTINGS_CREDENTIAL_TARGETS) {
      // A wrong password throughout, so no target's success can move the next one's world —
      // and so both legs differ in exactly one thing: how old the session is.
      const body = { password: WRONG_PASSWORD };
      const refused = await formPost(target, { csrf: staleCsrf, ...body }, stale.cookie);
      expect(refused.status, `POST ${target} on a stale session`).toBe(302);
      expect(refused.headers.get("Location"), `POST ${target}`).toMatch(/^\/login(\?|$)/);
      // The twin: the same target, the same body, a session signed in moments ago. It
      // reaches better-auth and is refused there on the password's merits — a redirect
      // back to /settings, never a redirect to sign in again.
      const answered = await formPost(target, { csrf: freshCsrf, ...body }, fresh.cookie);
      expect(answered.status, `POST ${target} on a fresh session`).toBe(303);
      expect(answered.headers.get("Location"), `POST ${target}`).toContain(paths.settings);
    }
  });

  it("27. §4/§13 · /settings's Enable two-factor and Regenerate backup codes render the password control the credential seam reads — each form, filled and submitted exactly as the page drew it, is ACCEPTED by better-auth instead of refused for a field no browser could send", async () => {
    const owner = await seedNamespace(env.DB, {});
    const session = await seedOwnerSession(owner.owner);

    // Not enrolled, so the two-factor card draws its enable form and nothing else.
    const enable = formsPostingTo(await page(paths.settings, session.cookie), paths.auth.totpEnable);
    expect(enable.length, "/settings rendered no Enable two-factor form").toBeGreaterThan(0);
    for (const form of enable) {
      const answered = await formPost(
        paths.auth.totpEnable,
        typedInto(form, { password: SEEDED_OWNER_PASSWORD }),
        session.cookie,
      );
      expect(answered.status).toBe(303);
      // `done=`, not `failed=`: better-auth accepted the password this form carried. The
      // refusal leg is case 26's, where a wrong one comes back as `failed=`.
      expect(answered.headers.get("Location")).toContain("done=");
    }

    // The enable above created the two-factor row; this makes it live, which is the only
    // state in which the page draws its backup-code control at all.
    await enrollTwoFactor(owner.owner.userId);
    const regenerate = formsPostingTo(
      await page(paths.settings, session.cookie),
      paths.auth.backupCodesGenerate,
    );
    expect(regenerate.length, "/settings rendered no Regenerate backup codes form").toBeGreaterThan(0);
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

  it("§13/§19 · /oauth/connections lists each binding's client, bound agent, created and last-used · Revoke without a CSRF token is refused (the twin)", async () => {
    const { clientId } = await registerOAuthClient({ client_name: "Listed Client" });
    const { html, oauthQuery } = await reachConsent(clientId, world.session.cookie, {
      resource: oauthResourceFor(world.ns.owner.username),
    });
    const csrf = csrfOf(html);
    const accepted = await post(
      paths.oauthConsent,
      { oauth_query: oauthQuery, decision: "accept", agent: "agent" },
      { csrf },
    );
    expect(accepted.status, await accepted.text()).toBe(303);

    const listed = await page(paths.oauthConnections);
    expect(listed).toContain("Listed Client");
    expect(listed).toContain("agent");

    const binding = await bindingFor(world.ns.owner.userId, clientId);
    expect(binding).not.toBeNull();
    const target = paths.connectionRevoke(binding?.id ?? "");
    const refused = await post(target, {}, {});
    expect(refused.status).toBe(403);
    expect((await bindingFor(world.ns.owner.userId, clientId))?.revokedAt).toBeNull();

    // The twin: the same target, the page's own CSRF token.
    const accepted2 = await post(target, {}, { csrf: csrfOf(listed) });
    expect(accepted2.status).toBe(303);
    expect((await bindingFor(world.ns.owner.userId, clientId))?.revokedAt).not.toBeNull();
  });

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

    const connectionsHtml = await page(paths.oauthConnections);
    const before = await query(env.DB, world.ns.owner.userId, { event: "oauth.revoked" });
    const revoked = await post(
      paths.connectionRevoke(binding?.id ?? ""),
      {},
      { csrf: csrfOf(connectionsHtml) },
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
// D15 (2026-09-02) — rows landed as it.todo from docs/superpowers/plans/2026-09-02-d15-panes.md;
// each row's mechanics are on its `asserts:` line there. Numbered on landing.

describe(`§13 · the /settings shell — six panes behind one rail`, () => {
  it.todo(`§13 · each of the six settings panes answers at its own URL and /settings renders the Password pane · /settings/password is a 404, not an alias and not a redirect (the twin: the five other pane URLs all answer 200)`);
  it.todo(`§13 · every pane renders the same rail — six entries under Sign-in and Access, in the sign-in-then-holdings order, each linking to its own pane URL — the Password entry carries no marker where the five others do, and the entry for the pane being rendered is the only rail entry carrying aria-current="page"`);
  it.todo(`§13 · every rail count is the number of rows its own pane lists — passkeys, sessions, tokens and connected clients seeded to four different lengths, so no single number satisfies the rail`);
  it.todo(`§13 · the Two-factor rail marker is a status, not a count: it reads one way with TOTP enabled and another without it, and never a number · the Passkeys entry beside it is a number in both states (the twin)`);
  it.todo(`§4/§13 · the /settings gate is a prefix rule: a stale cookie and a bearer-sourced session are refused on all six panes, the two ops-backed ones included · the same six panes render on a session signed in moments ago (the twin)`);
  it.todo(`§4/§13 · every POST target under /settings/ refuses a day-old cookie carrying its own real CSRF token and never reaches its op — the credential targets and the two ops-backed panes' alike · the same posts from a fresh session are accepted (the twin)`);
  it.todo(`§13 · a mutation posted from a pane redirects back to that pane's own URL carrying its notice, and the pane at that Location renders it — done= from the ops-backed targets, failed= from a refused credential — never to the page root unless the root is the pane that rendered the form`);
  it.todo(`§13 · a confirm dialog rides the URL of the pane that owns it: every ?confirm= link a pane renders resolves to that same pane's path and draws its dialog there · the identical query on another pane's URL draws none (the twin)`);
  it.todo(`§13 · the six pane routes are the six strings §13 spells — /settings, /settings/two-factor, /settings/passkeys, /settings/sessions, /settings/tokens, /settings/clients — asserted against the literals once, since every other row reads them through paths`);
  it.todo(`§13 · no rendered page links /oauth/consent — it is chromeless and has no nav slot, by design · the same pages link all six settings panes (the twin)`);
  it.todo(`§13 · the mobile pill row lists the same six pane URLs in the same order as the rail, markerless, and shortens only the last label, to Clients — structure only, nothing visual`);
  it.todo(`§4/§13 · an Authorization header with no cookie is bounced to /login at a /settings POST — a credential target and an ops-backed one alike — and reaches neither better-auth nor the op · the identical submissions under the owner's cookie are accepted (the twin)`);
  it.todo(`§13 · nothing is added TO the consent screen either: /oauth/consent renders neither paned page's rail and neither pill row — chromeless, no nav slot · the same helpers find the six entries on a settings pane (the twin)`);
});

describe(`§4/§13 · the Password pane`, () => {
  it.todo(`§13 · /settings lands on the Password pane: current password, new password, confirm new password, Sign out my other sessions checked by default, Update password — and the footer that sends a forgotten password to the server script, verbatim`);
  it.todo(`§13/§4 · the length hint renders from the one configured minimum: a new password one character short is refused with the pane carrying no second number, sets no cookie and leaves the password already on file signing in · one of exactly PASSWORD_MIN_LENGTH characters is accepted (the twin)`);
  it.todo(`§13 · a wrong current password is refused with "That password is not right.", changes nothing and touches no session — the password already on file still signs in and a bystander session still opens a page · the right one changes it (the twin)`);
  it.todo(`§13 · new ≠ confirm is the one check the hub makes itself, made before better-auth is called: "The two entries do not match." comes back although the current password was right, the session id is unchanged and the password already on file still signs in · the same form with the two entries equal changes it (the twin)`);
  it.todo(`§13 · a refusal better-auth answers with a code the pane maps to no field changes nothing and renders neither mapped refusal sentence · a mapped code does render its own (the twin)`);
  it.todo(`§13 · the pane reports the gate's own clock: a session created a known number of minutes ago renders "Confirmed your identity N minutes ago." with that number, and a session of a different age renders a different one`);
  it.todo(`§13 · Update password with Sign out my other sessions left ticked walks end to end: "Password updated.", "2 other session(s) were signed out — this one stays.", better-auth's Set-Cookie carries a session id that is not the one that posted, the old cookie and the other browser session are sent to /login, the CLI's bearer is dead, and the Sessions pane afterwards offers no per-session Revoke and counts one`);
  it.todo(`§4/§13 · a password change derives nothing and revokes nothing in the token table: the app token and the agent token issued before it still authenticate afterwards — "App and agent tokens keep working: they do not derive from the password." made true rather than said`);
  it.todo(`§13 · unticking Sign out my other sessions is the whole difference: the change succeeds, this session's id is unchanged, the other sessions still open pages, and the success copy carries no sessions sentence (the twin of the flag)`);
  it.todo(`§13 · POST /settings/change-password without the CSRF field the pane rendered is 403 and the password is untouched — the old one still signs in · the same submission carrying it changes the password (the twin)`);
  it.todo(`§4/§13 · POST /settings/change-password with no credential at all — no cookie, no bearer — is bounced to /login and the password is untouched · the same submission under the owner's own fresh cookie reaches better-auth (the twin)`);
  it.todo(`§4 · better-auth's own /change-password mount enforces no freshness, so the hub's recent-auth gate is the only one the change has: a day-old cookie posting JSON straight at /api/auth/change-password is judged on the password it named, while the same cookie at /settings/change-password never reaches it`);
  it.todo(`§4 · the day-old cookie that can post none of /settings's credential targets cannot post Update password either — the action read off the rendered pane, walked stale and fresh · a session signed in moments ago reaches better-auth with the same body (the twin)`);
});

describe(`§13 · the Two-factor, Passkeys and Sessions panes`, () => {
  it.todo(`§13 · /settings/passkeys lists one row per passkey under the name the authenticator reported, and the rail's Passkeys marker is the number of rows the pane listed · with none, the pane renders "No passkeys yet. Add one to sign in without a password." and the marker reads 0 (the twin)`);
  it.todo(`§13 · each passkey row carries its own added stamp: two passkeys with the same name and different createdAt render two different rows`);
  it.todo(`§5/§13 · identity.stampPasskeyUse writes §5's last_used_at for the credential id it names — and only that one — and the pane's row reads "last used …" only after it: before the stamp the pane says it of no passkey (the twin)`);
  it.todo(`§13 · /settings/passkeys' Remove walks end to end as a browser walks it — the confirm link riding the pane's own URL, the dialog's form, the form-encoded POST, the redirect back to /settings/passkeys — and the row and its rail count are gone afterwards, while a guessed id draws no dialog at all (the twin)`);
  it.todo(`§13/§9 · Add passkey is the one credential control that is not a form: /settings/passkeys names better-auth's own generate-register-options and verify-registration endpoints inside a script calling navigator.credentials.create, in no action= and no href= · every form the same page renders posts to a hub route under /settings (the twin)`);
  it.todo(`§13 · /login's passkey button is live the same way — the page names generate-authenticate-options and verify-authentication in a script calling navigator.credentials.get, while its own username form still posts form-encoded to the hub's translation route (the twin)`);
  it.todo(`§13 · /settings/sessions lists every session under Client / Created / Last active, and the rail's Sessions marker is the number of rows the pane listed`);
  it.todo(`§13 · the session rendering /settings/sessions is badged current and offers no Revoke — no link on its row, and its own ?confirm=revoke-session draws no dialog · every other session's row carries both (the twin)`);
  it.todo(`§4/§13 · /settings/sessions' Revoke walks end to end as a browser walks it — the confirm link on the pane's own URL, the rendered form, the form-encoded POST, the redirect back to /settings/sessions — and the session it named is gone from the listing and from the rail count afterwards while the current one still opens the page`);
  it.todo(`§13 · Revoke all others walks end to end through better-auth's /revoke-other-sessions: every other session is gone and its cookie opens nothing, while the CURRENT session's id is unchanged, its cookie unreplaced and still opening the pane — the opposite contract from the Password pane's flag, which replaces it`);
  it.todo(`§13 · a CLI session is listed on /settings/sessions and revocable from it: after a device flow the pane's marker goes up by one and carries one more revoke link, and revoking that row kills the CLI's bearer while the browser session still opens the pane (the twin)`);
  it.todo(`§13 · /settings/two-factor is the Two-factor pane's one URL: it renders the card, its forms post to the same paths.auth targets as before, and its Disable confirm rides /settings/two-factor`);
  it.todo(`§9/§13 · every control the /settings panes render is claimed: the Sign-in panes and Sessions render only better-auth credential targets and no ops-backed form (§13's pinned exception, per pane), the two Access panes front ops keys, every ?confirm= link rides the pane that drew it, and Add passkey is the single enumerated exclusion`);
});

describe(`§13 · the Tokens pane`, () => {
  it.todo(`§13 · /settings/tokens lists every key in the namespace, agent and app alike — the set of ids its Revoke/Remove controls name is exactly token_list's unrevoked set, each listed key showing its display prefix, its kind and the slug it is bound to`);
  it.todo(`§13 · a bound-to app slug links to /apps/<slug> · the agent slug beside it is plain text and no anchor on the pane names an /agents/ path (the twin — the agents pages are deferred)`);
  it.todo(`§13 · the All · Agents · Apps filter narrows: ?kind=agent lists the namespace's agent keys and no app key, ?kind=app the reverse, and the unfiltered pane lists both (the twin) — each pill followed from the href the pane rendered`);
  it.todo(`§13 · Revoke on a live row walks end to end as a browser walks it — the form the pane rendered, posted form-encoded to /settings/tokens/token_revoke — and the key is gone from the pane afterwards while token_list still reports its row revoked`);
  it.todo(`§13 · an expired key's control reads Remove where a live key's reads Revoke, and both post the same token_revoke target under the pane's own prefix (the twin) — the expired row leaves the listing the same way`);
  it.todo(`§13 · the Tokens pane renders no token_issue control — "Issue new keys from an app or agent page." and its two-sentence footer render verbatim instead · the same pane does render token_revoke forms, so this is an absent control and not an absent pane (the twin)`);
  it.todo(`§13 · the two Access panes draw the column names §13 spells — Token / Kind / Bound to / Created / Expires / Last used under an All · Agents · Apps filter, and Client / Acts as / Created / Last used / Status — the same class of durable string the Sessions pane's three already pin`);
});

describe(`§13/§19 · the Connected clients pane`, () => {
  it.todo(`§13/§19 · GET /oauth/connections answers 301 to /settings/clients, and the pane it points at lists the binding — the redirect's code and target are pinned, not merely "a redirect"`);
  it.todo(`§13/§19 · the connections POST moved with its pane: nothing routes /oauth/connections/connection_revoke any more — it reaches connection_revoke zero times, and no rendered page posts under the old path · the same revoke at /settings/clients/connection_revoke reaches it exactly once and lands back on the pane (the twin)`);
  it.todo(`§13/§19.5 · a connected client's row shows the name it registered with, the ORIGIN of its registered redirect URI beneath it — never the full URI — and the bound agent's slug as plain text under Acts as · a client that registered without a name shows its client id in the name's place (the twin)`);
  it.todo(`§13/§19.5 · a self-registered (DCR) client's row carries the "unverified" marker · a client registered under the owner's own session does not (the twin) — the consent screen's second identity string, repeated on the pane`);
  it.todo(`§13 · the Connected clients footer renders verbatim, as one block — a client registers itself at the consent screen, and revoking touches neither the agent it acted as nor that agent's grants`);
  it.todo(`§13/§19.6 · Revoke walks end to end from an active row as a browser walks it — the confirm link on /settings/clients, the dialog whose own form names that row, the form-encoded POST to /settings/clients/connection_revoke, the 303 back to the pane — and the row STAYS listed afterwards as revoked with no control of any shape · it rendered one while it was active (the twin)`);
  it.todo(`§13 · a POST to either ops-backed Settings pane carrying no CSRF field is 403 and nothing is revoked · the same target carrying the token that pane rendered succeeds (the twin) — one gate over the /settings prefix, proven on both dispatches`);
  it.todo(`§19.4/§13 · consenting again after a revoke revives the same row — /settings/clients holds exactly one row for that client, active and revocable again, and oauth_binding still holds exactly one row for the pair`);
  it.todo(`§8 · the Tokens and Connected clients panes DO front ops, and each form's field set equals schemaKeysOf(ops[name]) — the two Access panes join parity direction B rather than the parity exception (the twin of the four panes that front none)`);
  it.todo(`§13 · the two Access markers part company on a revoked row by design: the Tokens marker counts the rows its pane lists — the live key and the expired one, never the revoked one — while the Connected clients marker counts ITS pane's rows with a revoked client among them · revoking through each pane's own control then moves the Tokens marker by one and the clients marker by none (the twin)`);
});

describe(`§13 · /apps/<slug> — the header and the Tools pane`, () => {
  it.todo(`§13 · /apps/<slug>/tools is a 404 — the landing pane has no alias · /apps/<slug> renders Tools and each of the seven other panes answers 200 at its own URL, carrying aria-current="page" on its own rail entry and on no other (the twin)`);
  it.todo(`§13 · the app rail carries exactly the eight entries of §13's pane table, App and Access as headings with the Danger zone ungrouped after them, and Overview and Danger zone carry no marker where the six others do (the twin)`);
  it.todo(`§13 · the header names the app, its slug and its kind badge — a tunneled app's status and last seen, a proxied app's endpoint, auth mode and forward identity read back from app_get's own row — and renders Connect/Reconnect and Disconnect only where auth is oauth · a headers-mode app renders neither target (the twin)`);
  it.todo(`§13 · every App-group rail marker is the number of rows its own pane lists — Tools, Prompts, and Resources as resources plus templates — and the Resources pane's two tabs carry those two counts at ?tab=resources and ?tab=templates`);
  it.todo(`§20.2/§13 · a tunneled app that declares prompts at registration carries a prompts count and lists them, while the app beside it that declared none dims to — (the twin), and the same live registration renders the header's online status and a last seen the never-connected app has not got`);
  it.todo(`§20.2/§13 · a family the app advertises none of dims its rail entry to — and its pane renders the empty state that says why, verbatim, per kind, with the family name substituted · the families it does advertise carry counts and list rows (the twin)`);
  it.todo(`§13 · a proxied app whose live listing fails renders BLANK App-group markers, never — and never 0, and its Tools pane renders "Token refresh failed — calls return errors until you reconnect." beside Reconnect instead of an empty list · a reachable app's markers are numbers and its Tools pane lists rows (the twin)`);
  it.todo(`§13 · a Tools row is the tool's name, the first line of its description and no args / N args, and its expanded block — the full description plus the Arguments table read off inputSchema — arrives in that same response, server-rendered, never a second request, beneath the pane's verbatim footer`);
  it.todo(`§13/§7 · the Tools pane is the owner's own unfiltered read: a tool no granted pattern reaches is listed all the same, beside the ones that are (§7 step 2 — owner → all tools)`);
  it.todo(`§13/§20.3 · "Called by agents as <slug>_<tool>" and the reachability line the door's own matcher computes: a literal role and a pattern role each name their agents and the role in the sentence §13 pins, an agent holding no grant on this app is named by neither, and a tool no granted pattern matches renders "Reachable by no agent yet" (the twin)`);
  it.todo(`§13/§2 · the approval posture is "No approval required" where every reaching agent reaches in allow mode and "Approval required for <agent>" where one reaches only in approval mode — an agent holding an allow role and an approval role that both match the same tool is named by neither line's approval half (allow wins)`);
  it.todo(`§13/§7 · the redaction line reads "No redacted fields" where nothing matches · it lists the writeOnly argument paths beside the redact and redact_results entries that match where something does, and a tool whose schema carries indirection the hub will not resolve reads "schema-unsound — approval-gated calls refuse, bodies are not recorded" (the twin)`);
  it.todo(`§13 · /apps/<slug> gets the pill row too — the shell rule applies although only MobileSettings was drawn: on every one of the eight panes the pill navigation lists the same eight pane URLs in the same rail order, markerless`);
  it.todo(`§13 · a tunneled app's Tools pane is the DO's cached catalog: the tools it advertised on its last connect are listed under a numeric Tools marker while its socket is open, and are still listed, unchanged and still counted, after the socket closes and the header reads offline`);
  it.todo(`§20.5/§13 · a tunneled app that declared no tools dims Tools to — and its LANDING pane renders the tunneled empty state with tools substituted, verbatim · the prompts the same app did declare carry a count and list a row (the twin)`);
  it.todo(`§20.6 · the Tools pane is the scoped endpoint's own listing and not a second read: tools/list posted to /<user>/mcp/<slug> with the owner's own bearer answers exactly the names the pane rendered and exactly the number its rail marker shows — for a tunneled app and for a proxied one`);
  it.todo(`§13 · a proxied app whose upstream cannot be reached at all renders the unread state rather than an empty one: its App-group markers are blank — never — and never 0 — and its Tools pane lists no tool and says nothing about the app advertising none · the reachable proxied app beside it lists rows under numeric markers (the twin)`);
});

describe(`§13/§20 · /apps/<slug> — Prompts, Resources, Roles and Overview`, () => {
  it.todo(`§13/§20.3 · the Prompts pane gives each prompt its name, description and declared arguments, the <slug>_<prompt> name, reachability over the role's PROMPT patterns alone — a tools-only role reaches no prompt — the fixed "Never approval-gated", and the redact entries matching the prompt's name`);
  it.todo(`§20.2/§13 · the Resources pane's rows are URI / Name / Type with templates listed by their raw uriTemplate, reachability is matched against the URI and against that raw template and NEVER against the name, no redaction line is rendered, and the pane carries §20's two rules`);
  it.todo(`§13/§20.1 · completion/complete gets no pane: the rail names no completions entry and /apps/<slug>/completions is a 404 · the seven pane URLs the table does name each answer 200 (the twin)`);
  it.todo(`§13/§20.3 · the Roles pane renders the declared roles in §20.3's canonical read shape under its kind's own sentence — tunneled adds the trust-boundary line, proxied says roles are config — and an app that declared none renders "No roles declared" beside the built-in-all fallback with none on its rail entry (the twin)`);
  it.todo(`§13/§8 · the Overview pane is app_get's row as a definition list — slug, created, kind, and a proxied app's endpoint, auth mode and forward identity — with body logging reading "On — tunneled default" / "Off — proxied default" at each kind's default, neither string where the owner set it explicitly, and none where no redaction is configured`);
  it.todo(`§13 · the five App-group panes edit nothing: Tools, Prompts, Resources, Roles and Overview render no mutating form of any kind · the same page's header and Danger zone do (the twin)`);
  it.todo(`§13 · the Resources pane draws the three column names §13 spells — URI / Name / Type — on both of its tabs, beside the rows they head`);
  it.todo(`§20.6/§20.2 · the aggregated name is tools and prompts only: neither Resources tab renders a <slug>_ name anywhere · the Prompts pane next door renders one and the Tools pane another (the twin)`);
  it.todo(`§20.6 · the Prompts and Resources panes are the scoped endpoint's own listings too — prompts/list, resources/list and resources/templates/list under the owner's own bearer answer exactly the names each pane rendered, exactly the count each tab shows, and the Resources rail marker is those two counts summed`);
});

describe(`§13 · /apps/<slug> — Agents, Token and the Danger zone`, () => {
  it.todo(`§13 · /apps/<slug>/access lists exactly the agents holding ≥1 grant on this app, read from agent_list's inline grants, and the rail's Agents marker is the number of rows it drew · an agent granted only on another app is absent here and present on that app's own pane (the twin)`);
  it.todo(`§13 · an Agents row is the agent's slug and description as text — no link to the deferred /agents/<slug> — one role · mode chip per grant with the built-in all marked built-in, and the pane renders no Edit grants control beside the rows it does render (deferred, §13), under its verbatim footer`);
  it.todo(`§13 · /apps/<slug>/token lists a tunneled app's live tokens by display prefix and the rail marker is that live count · the same app's revoked and expired tokens are absent from the pane though token_list still reports all three (the twin), and no plaintext appears anywhere on it`);
  it.todo(`§13 · Revoke on /apps/<slug>/token walks end to end as a browser walks it — the confirm link, the dialog carrying "Revoking closes the app's live connection.", the posted form, the redirect back to the token pane — and the key stops authenticating a tunnel while the app's other live key still does (the twin)`);
  it.todo(`§13 · Issue new token fronts token_issue { kind: "app" } from the token pane's own target — not the generic 303 dispatch — and renders the once-only reveal in place with "The previous token keeps working until you revoke it.", after which both keys authenticate a tunnel and the pane's marker reads 2 (§5: more than one live app token is legal)`);
  it.todo(`§13 · a proxied app's Token rail entry is the dimmed —, its pane says "Proxied apps hold no tokens — the hub dials the upstream; nothing dials in (§2)." and it renders no issue control — which token_issue agrees with by refusing kind: "app" on that app · a tunneled app's pane renders one (the twin)`);
  it.todo(`§13 · Archive on /apps/<slug>/danger walks end to end behind its dialog — "It refuses connections and leaves the list — tokens, grants and history are kept." — and afterwards the page still renders under the verbatim archived banner with its tokens and grants still listed and its header status reading archived, until Unarchive (posted as the browser posts it) takes the banner away again · the same page carried no banner before (the twin), and the Danger rail entry is an ordinary link carrying no marker`);
  it.todo(`§13 · Delete on /apps/<slug>/danger walks end to end behind its dialog — "Revokes its tokens, closes the live connection and removes every grant. This cannot be undone." — and afterwards the app's page is byte-identical to an unknown slug's 404 · a sibling app's page still renders (the twin)`);
  it.todo(`§13 · every /apps row links to its detail page, the archived section included, while the builtin pmcp row links to none — and the list's own Archive / Unarchive / Delete / Connect actions are still rendered beside the link (the twin)`);
  it.todo(`§8 · every mutating form the /apps/<slug> panes render fronts a real admin.ops key and submits within that op's schema — every required field, and no field the schema does not declare — so the page that issues and revokes app tokens joins parity direction B instead of standing outside it`);
  it.todo(`§13 · the Agents pane draws the two column names §13 spells — Agent and Granted roles — over the rows they head · the same render carries the slugs, descriptions and role · mode chips those columns describe (the twin)`);
  it.todo(`§8/§13 · Issue new token reaches the op although its route answers 200 instead of the generic redirect: the post writes exactly one admin.token_issue audit row naming the app and the id token_list then reports, and that row carries neither the revealed key nor any token material`);
  it.todo(`§9/§13 · every ?confirm= link the eight /apps/<slug> panes render rides the pane that drew it and draws its dialog there · the same query moved onto another pane's URL, and an id naming no row, each draw none (the twin)`);
  it.todo(`§13 · an archived app's page keeps its catalog: after Archive is posted from the danger pane the banner page still lists the tools the app advertised and its Tools marker is still that number · the same page listed them under the same marker before the archive (the twin)`);
});

describe(`§13 · /apps/<slug> — refusals and reserved segments`, () => {
  it.todo(`§13 · /apps/pmcp, an unknown slug and another namespace's real slug are one 404, byte-identical — reserved, nonexistent and foreign are indistinguishable, and app_get refuses pmcp the same way · the owner's own app renders at the same shape (the twin)`);
  it.todo(`§13 · /apps/new still renders the add-app form and POST /apps/connect still starts the upstream redirect — a static segment mounted under /apps/ wins over the slug route, which answers the 404 for every other name (the twin)`);
  it.todo(`§13 · every /apps/<slug> pane is behind the ordinary owner session: an anonymous GET of the detail page and of each of the seven pane URLs bounces to /login, and so does a bearer with no cookie · the same URLs under the owner's cookie render (the twin)`);
  it.todo(`§13 · /apps/<slug> is the ordinary owner session and nothing stricter: the day-old cookie the six /settings panes bounce to /login renders the app page, all seven of its panes, and posts the danger pane's own Archive form (the other half of §13's gate sentence)`);
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
    paths.settings,
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
