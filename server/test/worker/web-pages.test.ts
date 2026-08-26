// web-pages.test.ts — the browser surface, kept thin on purpose. §13's pages carry no
// business logic, so this suite deliberately pins only what is TRUE OF THE PAGES and false
// nowhere else: the CSRF gate (with the ops handler provably not run — a 403 that still
// mutated is the failure this file exists to catch), cookie-session-only access with
// `/approvals/<id>` owner-only, the one paging contract behind two presentations
// (`{ rows, total }`) with the JSONL export's line count equal to `total`, and parity
// DIRECTION B: every mutating form's fields are exactly the fronted op's schema keys.
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

// deps: harness/seed · src/index (exports.default.fetch) · src/admin (ops — one handler substituted to prove non-execution) · src/audit · src/approvals · src/identity (session minting) · applyD1Migrations

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
import { Registry } from "../../src/registry";
import type { Service } from "../../src/registry";
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
 * is the correct answer for /audit and the required answer for /account.
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
  /** The oauth-mode proxied service the callback case connects. */
  oauth: { service: Service; scenario: UpstreamScenario };
};

let world: World;

beforeAll(async () => {
  const scenario: UpstreamScenario = {
    id: uniqueSlug("up"),
    mode: { kind: "ok" },
    as: { id: uniqueSlug("as") } as AsScenario,
  };
  const ns = await seedNamespace(env.DB, {
    services: [
      { slug: "news", kind: "tunnel", tokens: [{ as: "news" }] },
      { slug: "parked", kind: "tunnel", archived: true },
      {
        slug: "notion",
        kind: "proxy",
        upstreamUrl: upstreamUrlFor(scenario),
        upstreamAuthMode: "oauth",
      },
    ],
    accounts: [
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
    new Request(`${ORIGIN}${paths.services}`, { headers: { Cookie: session.cookie } }),
  );
  const service = await new Registry(env.DB).getService(ns.owner.userId, "notion");
  if (service === null) throw new Error("web-pages: the seeded oauth service vanished");

  await seedAuditRows(ns.owner.userId);

  world = {
    ns,
    session,
    other,
    sessionId,
    deviceToken: await deviceFlowToken(session.cookie),
    approvalId: await openApproval(ns, "news"),
    foreign: await foreignWorld(),
    oauth: { service, scenario },
  };
});

/** A namespace that is not the fixture owner's, with a pending approval of its own —
 *  the only way to ask "does /approvals/<id> refuse someone else's id" honestly. */
async function foreignWorld(): Promise<World["foreign"]> {
  const ns = await seedNamespace(env.DB, {
    services: [{ slug: "news", kind: "tunnel" }],
    accounts: [{ slug: "agent", grants: { news: [{ role: "all", mode: "approval" }] } }],
  });
  return { ns, approvalId: await openApproval(ns, "news") };
}

/**
 * One pending approval, opened the only way one is ever opened: a gated call through
 * `Approvals.check`. Nothing here writes an approval row by hand — a fixture that did
 * would be pinning a shape rather than a behavior.
 */
async function openApproval(ns: SeededNamespace, slug: string): Promise<string> {
  const service = await new Registry(env.DB).getService(ns.owner.userId, slug);
  if (service === null) throw new Error(`openApproval: no service "${slug}"`);
  const approvals = new Approvals({
    db: env.DB,
    publicOrigin: ORIGIN,
    audit: { record: (entry) => record(env.DB, entry) },
    retentionDays: 7,
    now: Date.now,
  });
  const checked = await approvals.check(
    { kind: "service_account", accountId: ns.accounts.agent.id, ownerId: ns.owner.userId, slug: "agent" },
    service,
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
      principal: "sa:agent",
      event: "tools/call",
      service: "news",
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
  const codes = (await (
    await call(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
      }),
    )
  ).json()) as { device_code: string; user_code: string };
  await call(new Request(`${ORIGIN}/api/auth/device?user_code=${codes.user_code}`, { headers: asOwner }));
  await call(
    new Request(`${ORIGIN}/api/auth/device/approve`, {
      method: "POST",
      headers: asOwner,
      body: JSON.stringify({ userCode: codes.user_code }),
    }),
  );
  const redeemed = await call(
    new Request(`${ORIGIN}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: codes.device_code,
        client_id: DEVICE_CLIENT_ID,
      }),
    }),
  );
  const body = (await redeemed.json()) as { access_token?: string };
  if (!body.access_token) throw new Error(`device token failed: ${JSON.stringify(body)}`);
  return body.access_token;
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

/** Every page that renders a credential form — /login's three cards, the signed-in shell's
 *  Sign out, /account's two-factor controls, and the destructive confirm dialog. */
async function credentialPages(cookie: string): Promise<string[]> {
  return [
    await anonymousPage(paths.login),
    await anonymousPage(`${paths.login}?step=totp`),
    await anonymousPage(`${paths.login}?step=backup-code`),
    await page(paths.services, cookie),
    await page(paths.account, cookie),
    await page(paths.accountConfirm("disable-two-factor"), cookie),
  ];
}

/** The confirm link /account renders beside one session's Revoke button, or null when it
 *  rendered none — built from `paths` so the page and the walk cannot spell it differently. */
function revokeLinkFor(html: string, sessionId: string): string | null {
  const link = paths.accountConfirm("revoke-session", sessionId);
  return html.includes(link.replace(/&/g, "&amp;")) ? link : null;
}

/** The session id behind a cookie — identity's own answer, the same one /account badges. */
async function sessionIdOf(cookie: string): Promise<string> {
  const { sessionId } = await requireOwnerSession(
    new Request(`${ORIGIN}${paths.account}`, { headers: { Cookie: cookie } }),
  );
  return sessionId;
}

/**
 * Substitutes counting handlers into the ops table for the length of one case and restores
 * them there — the mechanism the "was it invoked" cases rest on. The substitute records
 * its input and does NOTHING else, so a page that mutated D1 on its own would leave a
 * change nothing accounts for (case 19).
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
  // `/` names no segment, so it must not 404: a signed-in owner lands on their services,
  // an anonymous visitor on sign-in. Both are 302s, driven through the real composition root.
  it("GET / with an owner cookie → 302 /services", async () => {
    const response = await call(new Request(`${ORIGIN}/`, { headers: { Cookie: world.session.cookie } }));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/services");
  });

  it("GET / with no session → 302 /login", async () => {
    const response = await call(new Request(`${ORIGIN}/`));
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("§13 · CSRF on every mutating POST", () => {
  it("1. §13 · a mutating POST with no CSRF field is 403 AND the substituted ops handler was never invoked (a rejected-but-executed mutation is the bug this case exists for)", async () => {
    await withCountedOps(["service_archive"], async (invocations) => {
      const refused = await post(paths.serviceArchive("news"), {});
      expect(refused.status).toBe(403);
      expect(times(invocations, "service_archive")).toBe(0);
    });
  });

  it("2. §13 · the same POST carrying the token the page rendered succeeds and the handler ran exactly once (the allow-twin of 1 — without it, `throw 403` passes)", async () => {
    await withCountedOps(["service_archive"], async (invocations) => {
      const csrf = csrfOf(await page(paths.services));
      const accepted = await post(paths.serviceArchive("news"), {}, { csrf });
      expect(accepted.status).toBe(303);
      expect(accepted.headers.get("Location")).toContain(paths.services);
      expect(times(invocations, "service_archive")).toBe(1);
      // The op received the slug the target named — the query string IS the argument.
      expect(invocations.get("service_archive")?.[0]).toMatchObject({ slug: "news" });
    });
  });

  it("3. §13 · a token minted under a different cookie session is 403, handler not invoked", async () => {
    await withCountedOps(["service_archive"], async (invocations) => {
      const foreignToken = csrfOf(await page(paths.services, world.other.cookie));
      const refused = await post(paths.serviceArchive("news"), {}, { csrf: foreignToken });
      expect(refused.status).toBe(403);
      expect(times(invocations, "service_archive")).toBe(0);
      // The twin, so "403" is not simply what this endpoint always answers: the SAME
      // session's own token passes.
      const own = csrfOf(await page(paths.services));
      expect((await post(paths.serviceArchive("news"), {}, { csrf: own })).status).toBe(303);
      expect(times(invocations, "service_archive")).toBe(1);
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
  it("6. §4 · a bearer-sourced (device-flow) session is refused on /account · a browser session renders it (the twin — the guard is about provenance, not about being logged out)", async () => {
    const cookieName = world.session.cookie.split("=")[0];
    const replayed = await get(paths.account, `${cookieName}=${world.deviceToken}`);
    expect(replayed.status).toBe(302);
    expect(replayed.headers.get("Location")).toMatch(/^\/login(\?|$)/);
    // The twin: the same page, the same guard, a browser session.
    const rendered = await get(paths.account);
    expect(rendered.status).toBe(200);
    expect(await rendered.text()).toContain(paths.auth.signOut);
  });

  it("7. §7 · an Authorization: Bearer header with no cookie opens no page — bearer tokens are never consulted on page routes", async () => {
    for (const bearer of [world.session.token, world.ns.tokens.agent.token, world.deviceToken]) {
      const refused = await call(
        new Request(`${ORIGIN}${paths.services}`, { headers: { Authorization: `Bearer ${bearer}` } }),
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
    const filters = { event: "tools/call", service: "news" };
    const first = await page(auditPath({ ...filters, limit: 3, offset: 0 }));
    const truth = await query(env.DB, world.ns.owner.userId, filters as AuditQuery);
    expect(matchedLine(first)).toBe(truth.total);
    // …and the two numbers really do differ on this page, which is what makes the
    // assertion above worth making.
    expect(renderedTools(first).length).toBe(3);
    expect(truth.total).toBeGreaterThan(3);
  });

  it("11. §13 · desktop page numbers and mobile \"Load more\" walk the same offset/limit contract to the same final row set", async () => {
    const filters = { event: "tools/call", service: "news", limit: 4 };
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
    const filters = { event: "tools/call", service: "news" };
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
  it("16. §8 · every form rendered on /services and /approvals names an ops key that exists in admin.ops (no form fronts a tool that is gone)", async () => {
    for (const path of [paths.services, paths.approvals]) {
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
    for (const path of [paths.services, paths.approvals]) {
      for (const form of formsRenderedOn(await page(path))) {
        if (BROWSER_ONLY_TARGETS.has(form.op)) continue;
        expect(form.fields, `${path} → ${form.op}`).toEqual(schemaKeysOf(ops[form.op]));
        checked += 1;
      }
    }
    expect(checked, "no ops-backed form was checked").toBeGreaterThan(0);
  });

  it("18. §8 · /account renders no ops-backed form at all — the pinned parity exception: credentials ride better-auth's endpoints and are never reachable from a pmcp tool", async () => {
    const forms = formsRenderedOn(await page(paths.account));
    expect(forms.length, "/account rendered no form to check").toBeGreaterThan(0);
    for (const form of forms) {
      expect(Object.prototype.hasOwnProperty.call(ops, form.op), `/account fronts "${form.op}"`).toBe(false);
    }
    // Every one of them posts to better-auth's mount instead, which is the exception
    // stated as a positive rather than as an absence.
    for (const form of formsRenderedOn(await page(paths.account))) {
      expect(BETTER_AUTH_ACTIONS.has(form.op), `/account fronts "${form.op}"`).toBe(true);
    }
  });

  it("19. §8 · every page mutation reaches an ops handler (or better-auth): no page route mutates D1 on its own — the no-web-only-capability invariant, checked by substituting handlers across the ops table rather than by reading web.ts", async () => {
    // Everything the pages have to SAY is read first, while the ops table is still real:
    // the targets they render, and the token they rendered them with. The substitution
    // below replaces the read handlers too, so a page cannot be rendered under it — which
    // is itself the parity invariant showing through (a page has no other source).
    const targets = new Map<string, string>();
    let csrf = "";
    for (const path of [paths.services, paths.approvals]) {
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
    const started = await beginConnect(world.oauth.service, { id: world.sessionId });
    const redirected = await fetch(started.toString(), { redirect: "manual" });
    const callbackUrl = redirected.headers.get("Location");
    expect(callbackUrl, "the fake AS answered no redirect").not.toBeNull();
    const state = started.searchParams.get("state") ?? "";

    const anonymous = await call(new Request(callbackUrl ?? ""));
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("Location")).toMatch(/^\/login(\?|$)/);
    // Nothing ran and nothing was stored: the single-use state is still unconsumed and
    // the service still holds no credential.
    expect(await stateRows(state)).toBe(1);
    expect(await connectionOf("notion")).toBe("not_connected");

    // The twin: the same callback, the owner's browser session.
    const completed = await call(
      new Request(callbackUrl ?? "", { headers: { Cookie: world.session.cookie } }),
    );
    expect(completed.status).toBe(302);
    expect(completed.headers.get("Location")).toContain(paths.services);
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
      // Deliberately NOT the default landing page: /services is also where a missing or
      // refused callbackURL falls back to, so asserting it would pass either way. This is
      // the deep link /login carries through the round trip (LoginProps.redirectTo).
      callbackURL: paths.audit,
    });
    expect(answered.status, await answered.text()).toBe(303);
    expect(answered.headers.get("Location")).toBe(paths.audit);
    const cookie = sessionCookieOf(answered);
    expect(cookie, "the sign-in set no session cookie").not.toBeNull();
    // The cookie is a real session, not merely a header: it opens a page that requires one.
    const opened = await get(paths.services, cookie ?? "");
    expect(opened.status).toBe(200);
    expect(await opened.text()).toContain(signer.owner.username);
  });

  it("22. §15 · a wrong password re-renders /login with its field error and NO session cookie (the refusal twin of 21) — and the password appears in neither the redirect nor the page", async () => {
    const action = actionFor(await anonymousPage(paths.login), "username");
    const wrong = "FAKE0000-not-the-seeded-password";
    const answered = await formPost(action, {
      username: signer.owner.username,
      password: wrong,
      callbackURL: paths.services,
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
      const answered = await formPost(action, { code: "000000", callbackURL: paths.services });
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

  it("25. §4 · /account's Revoke walks end to end as a browser walks it — the confirm link, the rendered form, the form-encoded POST — and the session it named is gone from the listing afterwards while the current one stays", async () => {
    const doomed = await seedOwnerSession(world.ns.owner);
    // Resolved BEFORE the revoke: afterwards the cookie names no session, which is the
    // postcondition rather than a way to ask for the id.
    const doomedId = await sessionIdOf(doomed.cookie);
    const listed = await page(paths.account);
    const confirm = revokeLinkFor(listed, doomedId);
    expect(confirm, "/account rendered no revoke link for the second session").not.toBeNull();
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
    const after = await page(paths.account);
    expect(after).not.toContain(doomedId);
    // The twin: the revoke took one session, not the listing — the current one is still
    // here and still opens the page, while the revoked cookie is now nobody's.
    expect(after).toContain("current");
    expect((await get(paths.account, doomed.cookie)).status).toBe(302);
  });
});

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
 * Every mutating target that fronts no ops key, by name. Three are §8's pinned browser
 * interactions — the consent redirect, the per-browser push subscription, and the device
 * decision — and the rest are better-auth's own endpoints, which the shell's Sign out puts
 * on every page. A target outside this set and outside admin.ops is exactly the drift
 * cases 16 and 17 exist to catch.
 */
const BROWSER_ONLY_TARGETS: ReadonlySet<string> = new Set([
  "connect",
  "push",
  "decide",
  ...BETTER_AUTH_ACTIONS,
]);

/** Every session-backed page, rendered — the walk's input for case 4. */
async function sessionPages(): Promise<Record<string, string>> {
  const deviceCode = await requestDeviceCode();
  const rendered: Record<string, string> = {};
  for (const path of [
    paths.services,
    paths.serviceNew,
    paths.approvals,
    paths.approval(world.approvalId),
    paths.audit,
    paths.account,
    `${paths.device}?user_code=${encodeURIComponent(deviceCode)}`,
  ]) {
    rendered[path] = await page(path);
  }
  return rendered;
}

/** A live user code, claimed by the owner's session so /device renders its confirm step. */
async function requestDeviceCode(): Promise<string> {
  const requested = (await (
    await call(
      new Request(`${ORIGIN}/api/auth/device/code`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ client_id: DEVICE_CLIENT_ID }),
      }),
    )
  ).json()) as { user_code: string };
  return requested.user_code;
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

/** A service's upstream connection state, read the way /services reads it. */
async function connectionOf(slug: string): Promise<string> {
  const listed = (await ops.service_list.handler(world.ns.owner.userId, {})) as {
    services: { slug: string; connection?: string }[];
  };
  return listed.services.find((row) => row.slug === slug)?.connection ?? "not_connected";
}

/**
 * Everything a page mutation could have changed, as one comparable value: the services
 * and their flags, the approvals and their statuses. Case 19 compares it across a POST
 * whose op did nothing — if the page layer wrote to D1 itself, this moves.
 */
async function namespaceShape(): Promise<string> {
  const services = await (env.DB as D1Like)
    .prepare(
      `SELECT id, slug, archived_at, upstream_auth_json IS NOT NULL AS sealed
         FROM service WHERE owner_id = ? ORDER BY slug`,
    )
    .bind(world.ns.owner.userId)
    .all<Record<string, unknown>>();
  const approvals = await (env.DB as D1Like)
    .prepare(`SELECT id, status FROM approval WHERE owner_id = ? ORDER BY id`)
    .bind(world.ns.owner.userId)
    .all<Record<string, unknown>>();
  return JSON.stringify({ services: services.results, approvals: approvals.results });
}
