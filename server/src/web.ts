// The browser-only surface: server-rendered pages (Hono JSX), the PWA shell, and the
// CSRF discipline for every form the hub serves. Deliberately the shallowest module in
// the server — any depth here would be a web-only capability, which the parity
// invariant (§8) forbids: every mutation a page performs calls an admin ops handler or
// a better-auth endpoint (/login rides better-auth — the pinned exception),
// so zero business logic lives here. What this module owns and hides: which
// URL renders which template or the SPA shell; CSRF issuance, and the ORDER in which a
// mutation is gated (`mutation` — session, form, CSRF, then the body, written once so no
// handler can be spelled without it); where cookie-session gating is applied
// (identity.requireOwnerSession, with recent-auth on /settings's shells as a prefix rule —
// the JSON writes those panes make are api.ts's, behind its own twin of that prefix); the
// CREDENTIAL TRANSLATION routes /login keeps, which are the only reason a credential form
// works at all — better-auth's router takes `application/json` and nothing else, so a form
// posted at one of its endpoints is answered 415 and the hub owns those targets instead
// (see "The credential family" below, and pages/model's `paths.auth`); the chunked streaming
// JSONL export framing (never buffered); the web-app manifest and the minimal install+push
// service worker (no SPA, no offline rendering); and the stylesheet the shell links. Every
// clock the pages read is here too: `context` stamps `now` once per request, and /login —
// which has no session and so no context — is stamped at its own handler.
//
// Where the props come from is NOT here: pages/model.ts owns every read AND every
// props-builder, so a handler below is a gate, a loader call, and a render — and the ops
// table is reached through that one seam, the SPA's writes being api.ts's. better-auth is
// reached through identity's `callAuth` / `callAuthResponse`, its one custodian (§4), and
// never dialled from this module directly.
//
// Two things this module deliberately does not have. There is no route table export: a
// page's URL is `paths`'s to spell (pages/model.ts) and the composition root mounts this
// app whole. And there is no /oauth/upstream/callback shell: `upstream.handleCallback`
// takes the owner session itself, before it reads `state` at all (§7), so a wrapper here
// would be a second gate with nothing of its own to say.

import { env } from "cloudflare:workers";
import { Hono } from "hono";
import type { Context } from "hono";
import { ops } from "./admin";
import { AGENT_PANES, APP_PANES } from "./app-routes";
import { exportJsonl, record } from "./audit";
import { HubError } from "./errors";
import { callAuth, callAuthResponse, formatPrincipal, requireOwnerSession } from "./identity";
import type { OwnerSession } from "./identity";
import { upsertBinding } from "./oauth";
import { Registry } from "./registry";
import type { App, Violation } from "./registry";
import { beginConnect } from "./upstream";
import { ConsentPage } from "./pages/consent";
import { Login } from "./pages/login";
import { SpaShell } from "./pages/spa";
import {
  approvalOf,
  auditExportQuery,
  consentProps,
  hubRelative,
  loginProps,
  loginUrl,
  NOTICE_KEYS,
  paths,
  SETTINGS_PANES,
} from "./pages/model";
import { ICON_192, ICON_512 } from "./pages/icon";
import type { AuditExportQuery, PageContext } from "./pages/model";
// The one stylesheet, as bytes a worker can serve (see the *.css declaration in
// workers-env.d.ts for why an import is how it gets here).
import styles from "./pages/styles.css";

/**
 * The one thing a request carries from a gate to the handler under it: the session the
 * gate ALREADY resolved (`sessionOf` reads it back). Declared on hono's own variable map
 * rather than as an app-wide type parameter so that no handler and no `mutation`
 * signature below grows a generic to say it. api.ts reads the same variable for its own
 * `/api/hub/settings` prefix gate.
 */
declare module "hono" {
  interface ContextVariableMap {
    ownerSession?: OwnerSession;
  }
}

/**
 * hono's `Hono` app, opaque to the composition root: it mounts this at every segment
 * §13 gives the browser and hands it every request under them — including paths no page
 * serves, whose 404 is this app's own.
 */
type PageRouter = unknown;

/**
 * Builds the router for every browser-facing route. Cookie sessions only: bearer tokens
 * are never consulted on any page route, because the only gate below is
 * identity.requireOwnerSession, which reads a cookie and nothing else. Reads render over
 * the same handlers the pmcp tools front (pages/model.ts's loaders); mutations are
 * CSRF-checked POSTs into an admin ops handler or a better-auth endpoint, then redirect
 * back. Takes nothing and touches nothing at build time — every handler resolves its
 * bindings per request.
 *
 * The pages (all templates are Hono JSX, an implementation detail of this module):
 * - /login — username + password, TOTP challenge, passkey button; forms post to
 *   better-auth's endpoints.
 * - /device — the SPA shell (decision 38) behind the ordinary owner session: the
 *   phishing-defense page (RFC 8628 §5.4), whose card and CSRF-checked verdict are
 *   api.ts's `/api/hub/device` routes.
 * - /settings — the SPA shell at seven pane URLs (decision 38), behind the recent-auth
 *   prefix (§4). Its read and its eleven writes are api.ts's `/api/hub/settings/*`;
 *   nothing under this prefix is posted to.
 * - /audit — the SPA shell, gated exactly like /apps and /agents (decision 36); the
 *   explorer itself reads `/api/hub/audit/window` and `/api/hub/audit/<id>`. What survives
 *   here is `/audit/export.jsonl`, which streams via streamAuditJsonl and is a download
 *   rather than a page. No mutations, no CSRF.
 * - /approvals, /approvals/<id> — the SPA shell (decision 38), behind the owner session
 *   and, for an id, the same owner-scoped lookup the JSON read makes. Deciding and the
 *   push opt-in are api.ts's routes now; nothing under this prefix is posted to.
 * - /apps, /apps/new — app management fronting the app_* admin ops;
 *   Connect/Reconnect redirect into the upstream module's OAuth initiation.
 * - /oauth/consent — §19.5's inbound-OAuth consent screen: the provider redirects an
 *   authenticated, uncovered authorization request here with a signed query the page
 *   echoes back verbatim; the POST verifies with the provider's own /oauth2/consent
 *   BEFORE writing oauth_binding, so a refused request writes nothing.
 * - /oauth/connections — a 301 to /settings/clients, where §13 re-homed the bindings the
 *   consent screen produced. connection_list/connection_revoke are fronted by that pane,
 *   through `/api/hub/settings` and `/api/hub/settings/clients/connection_revoke`.
 * - /manifest.webmanifest, /sw.js, /styles.css — the PWA shell: installability, push,
 *   and the one stylesheet. The service worker handles push + notificationclick
 *   (opening /approvals/<id>) and never intercepts navigation (the no-SPA pin, §13).
 */
export function pageRoutes(): PageRouter {
  // deps: hono · identity.requireOwnerSession · admin.ops · pages/model (the loaders) ·
  // upstream.beginConnect · csrfTokenFor · csrfOk · streamAuditJsonl
  const app = new Hono();

  // A path under a browser segment that no page serves. The composition root hands this
  // app whole subtrees, so this is where "/apps/nonsense" is answered — and it is
  // deliberately not the hub's anonymous 404 (index.ts's segmentNotFound says why).
  app.notFound(() => noSuchPage());

  /* ---------------------------------- /login ---------------------------------- */

  // The one page with no session and no CSRF token of its own: there is nothing yet to
  // derive one from, and its forms post to better-auth, which brings its own defense (§4).
  // The clock is here rather than in the loader because this module holds every clock the
  // pages read (see `context`).
  app.get(paths.login, (c) => {
    const url = new URL(c.req.url);
    return render(Login(loginProps(new Date().toISOString(), url.searchParams, url.search)));
  });

  // /login's three credential forms, translated. better-auth's router accepts
  // `application/json` and nothing else, so the form posts these targets receive would be
  // answered 415 by its endpoints — these read the form, call better-auth as JSON through
  // identity's one door, and hand its Set-Cookie headers on (pages/model's `paths.auth`
  // states the whole arrangement).
  //
  // They are the one family of POSTs OUTSIDE `mutation`, and it is not a bypass: there is
  // no session here to gate with and none to derive a CSRF token from — which is exactly
  // why web-pages case 4 excludes /login from its walk. What guards them instead is the
  // pair below: the browser's SameSite session-cookie semantics, so a cross-site post
  // carries no session to ride, and `crossOrigin` — an Origin header, when the browser
  // sends one, that must be the hub's own (index.ts's consumer rule, same shape).
  app.post(paths.auth.signIn, (c) =>
    signInTranslation(c, "/sign-in/username", (form) => ({
      username: field(form, "username") ?? "",
      password: field(form, "password") ?? "",
    })),
  );

  app.post(paths.auth.totpVerify, (c) =>
    signInTranslation(c, "/two-factor/verify-totp", (form) => ({ code: field(form, "code") ?? "" }), "totp"),
  );

  app.post(paths.auth.backupCodeVerify, (c) =>
    signInTranslation(
      c,
      "/two-factor/verify-backup-code",
      (form) => ({ code: field(form, "code") ?? "" }),
      "backup-code",
    ),
  );

  // Sign out — the shell's form (layout.tsx), on every signed-in page. It needs
  // translating for a reason that looks like it should not apply: the form has NO controls
  // at all, so a browser posts an empty body under a form content type, and better-auth
  // refuses that too. It is also the one target here with no CSRF token, because
  // LayoutProps carries none to render one from; what stands in its place is `crossOrigin`
  // — the same origin rule better-auth applied while this form still posted to it.
  app.post(paths.auth.signOut, async (c) => {
    if (crossOrigin(c.req.raw)) return new Response("Forbidden", { status: 403, headers: TEXT });
    const answered = await callAuthResponse(c.req.raw, "/sign-out", {});
    // One destination either way: a sign-out that failed and one that worked look the same
    // to whoever clicked it, and /login is where both of them are. The cleared cookie, when
    // there is one, rides along.
    return redirectWith(paths.login, answered);
  });

  /* ---------------------------------- /device --------------------------------- */
  //
  // The SPA shell behind the ORDINARY owner session (decision 38, the third family), which
  // is also what carries the CLI's printed `?user_code=` through a sign-in: the gate's 302
  // names the whole URL as `next=`. The card's read and the verdict are api.ts's
  // `/api/hub/device` routes; nothing under this prefix is posted to any more.
  app.get(paths.device, shell("Approve device"));

  /* --------------------------------- /settings --------------------------------- */
  //
  // §13's seven panes, as the SPA shell (decision 38, the second family to move). The read
  // is `GET /api/hub/settings` and every write the panes' forms made is its JSON twin under
  // `/api/hub/settings/` (api.ts), gated by the same recent-authentication rule written as
  // ITS prefix middleware. No POST survives under this prefix: the eight credential
  // translations, the two `:op` dispatchers and the Execution save went with the forms.

  // §13's "A page's gate is every pane's gate", as ONE PREFIX RULE rather than a check per
  // route: every pane URL is behind this middleware, so a route added under /settings
  // cannot be added ungated — and a POST to a target that no longer exists meets the gate
  // before its 404. §4's recent-auth surface is what it proves: a session minted by the
  // device flow never qualifies, and a browser session older than better-auth's freshness
  // window is sent through a fresh sign-in. Both refusals are identity's, thrown as a
  // redirect. It reads a COOKIE and never `Authorization` — requireOwnerSession's own
  // contract. The resolved session is STASHED for `shell` to reuse (`sessionOf`), so the
  // decision is made once per request.
  const settingsGate = async (c: Context, next: () => Promise<void>) => {
    c.set("ownerSession", await requireOwnerSession(c.req.raw, { recent: true }));
    await next();
  };
  app.use(paths.settings, settingsGate);
  app.use(`${paths.settings}/*`, settingsGate);

  // One URL per pane and no alias for the landing one: `/settings/password` is answered by
  // this app's own 404, because no route claims it. Which pane a URL draws is the client's.
  for (const { href } of SETTINGS_PANES) app.get(href, shell("Settings · personal-mcps"));

  /* ---------------------------------- /audit ---------------------------------- */
  //
  // §13's explorer, as the SPA's third route family (2026-09-21, decision 36). One shell
  // behind the same session gate as `/apps` and `/agents`, and the export beside it — which
  // was never the page's: it is a Worker route because a JSONL stream is a download, and it
  // stays at its own URL because a bookmark must not break.

  app.get(paths.audit, shell("Audit"));

  // The same read, framed as lines instead of a page (§8's pinned parity exception):
  // same filters, same order, and never a capability of its own.
  //
  // The link is a TRUST BOUNDARY and the only place a refusal can still be a sentence: once
  // the stream is open, an unusable selection is a D1 error partway through a download.
  // So the parse refuses here — a malformed `target`, and a selection with more values than
  // one prepared statement can bind — and nothing is read.
  app.get(paths.auditExport, async (c) => {
    const session = await requireOwnerSession(c.req.raw);
    const ctx = await context(c.req.raw, session);
    const asked = auditExportQuery(ctx);
    if ("reason" in asked) return new Response(`${asked.reason}\n`, { status: 400, headers: TEXT });
    return streamAuditJsonl(session.user.userId, asked.query);
  });

  /* -------------------------------- /approvals -------------------------------- */
  //
  // §13's approvals pages, as the SPA shell (decision 38, the first family to move). The
  // reads are `/api/hub/approvals` and `/api/hub/approvals/<id>`; Approve and Reject are
  // `approval_decide` through the ops allowlist and the push opt-in is
  // `/api/hub/approvals/push` (api.ts). No POST survives under this prefix — the generic
  // `/approvals/:op` dispatcher that admitted every op by name went with the forms.

  app.get(paths.approvals, shell("Approvals"));

  // A GET here is an id, and an id that is not this owner's is not an id at all (§13): the
  // document 404 is decided before any HTML, as `/apps/<slug>`'s is.
  app.get("/approvals/:id", shell("Approve request · personal-mcps", approvalExists));

  /* -------------------------------- /apps --------------------------------- */
  //
  // §13's app pages, as the SPA shell (2026-09-18). Static segments first, which is what
  // keeps `/apps/new` a page rather than a slug — the same precedence app-routes'
  // RESERVED_APP_SLUGS makes `app_create` refuse — then the two retained 301s, then the
  // app's own routes.
  //
  // One POST survives under this prefix, and only one: `/apps/connect`, which answers a 303
  // to a THIRD-PARTY authorize URL. A `fetch` cannot follow a cross-origin redirect into the
  // address bar, so that interaction stays a real form submission and the client renders a
  // `<form method="post">` for it. Everything else a pane used to post is a call to
  // `/api/hub` now.

  app.get(paths.apps, shell("Apps"));
  app.get(paths.appNew, shell("Add app"));

  // The two URLs the family panes lived at until 2026-09-17, moved for good: the Catalog
  // holds all three families now, so a bookmark should stop coming back here — 301 rather
  // than 302, and the query is dropped with the pane that read it. Mounted ahead of the
  // pane route so neither segment ever reads as a pane.
  app.get("/apps/:slug/prompts", (c) => c.redirect(paths.appPane(c.req.param("slug") ?? "", "catalog"), 301));
  app.get("/apps/:slug/resources", (c) => c.redirect(paths.appPane(c.req.param("slug") ?? "", "catalog"), 301));

  // The landing and the seven panes. `tools` is deliberately not a pane: the families moved
  // into the Catalog, so `/apps/<slug>/tools` falls to the 404 below rather than aliasing
  // anything. The pane list is app-routes', so a pane added there is served here with no
  // second edit.
  app.get("/apps/:slug", shell("App", appExists));
  app.get("/apps/:slug/:pane", async (c) => {
    const pane = c.req.param("pane") ?? "";
    // Ahead of the session gate, exactly where it was: an unknown segment is not a page,
    // and whether it is one cannot depend on who is asking.
    if (!(APP_PANES as readonly string[]).includes(pane)) return noSuchPage();
    return shell("App", appExists)(c);
  });

  // Connect and Reconnect: §8's one browser-only interaction, which is why it fronts no
  // tool. Everything it does — discovery, client identity, the single-use state row —
  // belongs to upstream; this hands it the app and the session and redirects.
  app.post(
    paths.appConnect(""),
    mutation((c, session) =>
      connectRedirect(c, session, new URL(c.req.url).searchParams.get("slug") ?? ""),
    ),
  );

  /* -------------------------------- /oauth/consent ------------------------------ */
  //
  // §19.5's whole security boundary: the provider redirects an authenticated, uncovered
  // authorization request here, signed query and all. `requireOwnerSession` is the same
  // cookie gate every other page uses — a missing session bounces to /login carrying this
  // page's own URL (query included) as `next=`, which is §19.5 step 1's "carries the query
  // through" for a browser that reloaded here after its cookie expired mid-flow.

  app.get(paths.oauthConsent, async (c) => {
    const session = await requireOwnerSession(c.req.raw);
    const ctx = await context(c.req.raw, session);
    const props = await consentProps(ctx, c.req.raw);
    // null means the provider's own signature check on the query failed (edited, expired,
    // or an unknown client) — nothing to render, and nothing was ever going to be written.
    if (props === null) return new Response("Bad Request", { status: 400, headers: TEXT });
    return render(ConsentPage(props));
  });

  // The consent decision: §13's strictest mutation gate (session, form, CSRF, body), because
  // this POST both writes a binding and authorizes a client. It VERIFIES BEFORE IT WRITES
  // (§19.5 step 4): the provider's own `/oauth2/consent` is called before any write of the
  // hub's, carrying the session, and only on ITS success does anything land in
  // `oauth_binding` or the ledger — a provider refusal (an edited `oauth_query`, an expired
  // one) writes nothing at all.
  app.post(
    paths.oauthConsent,
    mutation(async (c, session, form) => {
      const oauthQuery = field(form, "oauth_query") ?? "";
      const accept = field(form, "decision") === "accept";
      // The chosen agent is resolved BEFORE the provider is called (brief §5.3, 2026-09-23):
      // a read ahead of the first write, so an agent that does not resolve is refused with
      // nothing written ANYWHERE. Refused after the provider had accepted, it left a consent
      // there with no binding here — the next authorize skipped this screen, and the token it
      // minted was refused at the door until the provider's consent was cleared.
      const chosen = accept ? await consentedAgentOf(session, oauthQuery, field(form, "agent") ?? "") : null;
      if (accept && chosen === null) return new Response("Bad Request", { status: 400, headers: TEXT });
      // The provider answers `{ redirect: true, url }` at runtime — its OpenAPI schema
      // documents `redirect_uri`, but `url` is what the endpoint actually returns (verified
      // against the running provider), so both are read and whichever it gave wins.
      const answered = await callAuth<{ url?: unknown; redirect_uri?: unknown }>(c.req.raw, "/oauth2/consent", {
        accept,
        oauth_query: oauthQuery,
      });
      const redirectUri = answered?.url ?? answered?.redirect_uri;
      if (typeof redirectUri !== "string") {
        return new Response("Bad Request", { status: 400, headers: TEXT });
      }
      if (chosen !== null) {
        const refused = await bindConsentedAgent(session, chosen);
        if (refused !== null) return refused;
      }
      // The hub performs the final browser redirect (§19.5 step 4) — the provider already
      // validated `redirect_uri` at authorize time (§19.3), so nothing here re-checks it.
      return c.redirect(redirectUri, 303);
    }),
  );

  /* ------------------------------- /oauth/connections --------------------------- */

  // The list moved into Settings and the old URL is now a PERMANENT redirect to the pane
  // that holds it (§13/§19): 301 rather than 302, because the move is not temporary and a
  // bookmark should stop coming back here. No POST dispatcher of its own any more either —
  // Revoke moved with the pane, and since decision 38 it is
  // `POST /api/hub/settings/clients/connection_revoke`. Deliberately ungated: it renders
  // nothing, so there is nothing to gate, and the pane it points at is behind /settings's
  // own prefix rule.
  app.get(paths.oauthConnections, (c) => c.redirect(paths.settingsClients, 301));

  /* -------------------------------- the shell --------------------------------- */

  // Installability is not gated and the shell holds nothing to gate: no session, no
  // namespace, no data — a manifest and a service worker are the same bytes for every
  // visitor, signed in or not (§13).
  app.get(paths.manifest, () =>
    Response.json(
      {
        name: "personal-mcps",
        short_name: "pmcp",
        description: "The MCP hub's own console.",
        // Where an installed icon opens: the page an owner actually starts on.
        start_url: paths.apps,
        scope: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        // Exactly the pair Chromium's install criterion is built around, each entry's own
        // bytes at its own size. No `sizes: "any"` (the spelling that fails Android WebAPK
        // install, chromium issue 40925759) and no `purpose` (not part of the gate;
        // omitted means `any`, which is what iOS's fallback wants).
        icons: [
          { src: paths.icon192, sizes: "192x192", type: "image/png" },
          { src: paths.icon512, sizes: "512x512", type: "image/png" },
        ],
      },
      { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } },
    ),
  );

  // Push and notificationclick, and NOTHING else: no fetch handler at all, which is the
  // no-SPA pin (§13) as code rather than as a promise — this worker cannot intercept a
  // navigation because it never registers to.
  app.get(paths.serviceWorker, () => new Response(SERVICE_WORKER, { headers: JAVASCRIPT }));

  app.get(paths.stylesheet, () => new Response(styles, { headers: CSS }));

  // The browser client, straight out of the ASSETS binding. The raw request goes through
  // unmodified, so the asset lookup is `web/dist/app.js` / `web/dist/app.css` with no
  // prefix to rewrite and no second spelling of either name; wrangler's `run_worker_first`
  // is what makes these two routes the only reachable path into that directory.
  app.get(paths.clientScript, (c) => env.ASSETS.fetch(c.req.raw));
  app.get(paths.clientStylesheet, (c) => env.ASSETS.fetch(c.req.raw));

  // The manifest's two icons and the head's `rel="icon"`: bytes from pages/icon.ts, the
  // same in the suite and in production, which is the whole reason they are not a file.
  app.get(paths.icon192, () => new Response(ICON_192, { headers: PNG }));
  app.get(paths.icon512, () => new Response(ICON_512, { headers: PNG }));

  /* -------------------------------- /agents ---------------------------------- */
  //
  // §13's agents pages, as the SPA shell (2026-09-18). Static segments first (`/agents/new`
  // is a page, never an agent — admin refuses the slug), then the two retained 301s, then
  // the agent's own routes. Each shell gate is the ordinary owner session, like
  // `/apps/<slug>/*`, and each existence check runs before any HTML is emitted so the
  // document 404s §13 pins survive the rewrite.
  //
  // There are no mutation POSTs under this prefix any more: every one of them is a call to
  // `/api/hub` now, and a second spelling of the same op would be one op with two contracts.

  app.get(paths.agents, shell("Agents"));
  app.get(paths.agentNew, shell("New agent"));

  // The two URLs the 2026-09-03 editor lived at, moved for good: 301 rather than 302,
  // because the page they named is gone and a bookmark should stop coming back here.
  // Mounted ahead of the pane route so `grants` never reads as a pane segment.
  app.get("/agents/:slug/grants", (c) => c.redirect(paths.agentPane(c.req.param("slug") ?? "", "grant"), 301));
  app.get("/agents/:slug/grants/:app", (c) =>
    c.redirect(paths.agentApp(c.req.param("slug") ?? "", c.req.param("app") ?? ""), 301),
  );

  // One (agent × app) pair's pane. Two segments rather than one, because this is the only
  // pane carrying an argument — which is also why it is not in `AGENT_PANES`. All three
  // existence checks ride in `agentAppExists`.
  app.get("/agents/:slug/apps/:app", shell("Agent", agentAppExists));

  // The four single-segment panes. LAST of the `/agents/:slug/*` GETs, so `new` and
  // `grants` are both claimed before a segment reaches here.
  app.get("/agents/:slug", shell("Agent", agentExists));
  app.get("/agents/:slug/:pane", async (c) => {
    const pane = c.req.param("pane") ?? "";
    // Pane-name validation stays AHEAD of the session gate, exactly where it was: an
    // unknown segment is not a page, and whether it is one cannot depend on who is asking.
    if (!(AGENT_PANES as readonly string[]).includes(pane)) return noSuchPage();
    return shell("Agent", agentExists)(c);
  });

  return app;
}

/* ------------------------------------------------------------------ *
 * CSRF
 * ------------------------------------------------------------------ */

/**
 * The CSRF token embedded as a hidden field in every mutation form this module
 * renders. Stable for the life of the cookie session — a form left open in another
 * tab still submits — and meaningless outside it; derived, never stored server-side.
 * `sessionToken` is the session's own stable identifier (identity's OwnerSession.sessionId),
 * so the token survives a cookie refresh and dies with the session itself.
 */
async function csrfTokenFor(sessionToken: string): Promise<string> {
  // deps: crypto.subtle
  // Keyed on the SESSION, with the signing secret mixed in where there is one. The
  // session's own identifier is already the unguessable value a cross-site attacker
  // cannot read — that is what makes it a session — so the token is unforgeable without
  // it, and a deployment whose BETTER_AUTH_SECRET is absent (dev, the test pool) still
  // has a working gate instead of a 500 at the door.
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${sessionToken}:${env.BETTER_AUTH_SECRET ?? ""}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("pmcp-csrf"));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * EVERY mutating page POST, as one handler shape: the session gate, the form, then the
 * CSRF check — and only then the body, which is handed an already-gated session and form.
 * The order is load-bearing and this is the only place it is written, so "no handler ever
 * sees an unverified mutation" is true by construction rather than by agreement at five
 * call sites; a sixth mutation cannot forget it, because the wrapper is how a mutation is
 * spelled. It is also the one place a further cross-cutting check (an origin rule, a rate
 * limit) has to go.
 *
 * GETs and the OAuth callback are outside its scope: a read mutates nothing, and the
 * callback's replay defense is the single-use `state`, owned by upstream.
 */
function mutation(
  handle: (c: Context, session: OwnerSession, form: FormData) => Promise<Response>,
): (c: Context) => Promise<Response> {
  // deps: sessionOf · csrfOk
  return async (c) => {
    const session = await sessionOf(c);
    const form = await c.req.formData();
    if (!(await csrfOk(session.sessionId, field(form, "csrf")))) {
      return new Response("Forbidden", { status: 403, headers: TEXT });
    }
    return handle(c, session, form);
  };
}

/**
 * The session a handler runs under: the `/settings` prefix gate's, when that gate ran, and
 * otherwise this route's own ordinary one. The gate is the only thing that ever stashes
 * one, so "already resolved" means exactly "under /settings" — and the fallback is what
 * every route outside that prefix takes, which is why this is not a cache with a lifetime
 * but a read of what the request already decided. A stashed session is always the STRICTER
 * one (the gate asks for §4's recent authentication unconditionally), so reusing it can
 * never admit a session the ordinary gate would have refused.
 */
async function sessionOf(c: Context): Promise<OwnerSession> {
  // deps: identity.requireOwnerSession
  return c.get("ownerSession") ?? requireOwnerSession(c.req.raw);
}

/**
 * The check itself: a presented CSRF token against the cookie session it must have been
 * minted for. True to proceed. Separate from its callers because it is the decision, and
 * they are the ordering and the carrier — the form field for a page POST, the
 * `X-Pmcp-Csrf` header for the JSON API.
 */
export async function csrfOk(sessionToken: string, presented: string | null): Promise<boolean> {
  // deps: csrfTokenFor
  const expected = await csrfTokenFor(sessionToken);
  return presented !== null && presented.length === expected.length && presented === expected;
}

/* ------------------------------------------------------------------ *
 * The credential family: form-encoded in, JSON at better-auth
 * ------------------------------------------------------------------ */

/**
 * ONE fact makes this section exist: better-auth's router accepts `application/json` and
 * nothing else, so every `<form method="post">` the credential pages render — which is how
 * a server-rendered page submits anything — is answered 415 UNSUPPORTED_MEDIA_TYPE by its
 * endpoints. The templates are §13's contract and are not the thing to change, so the hub
 * owns the targets instead (pages/model's `paths.auth`) and each one is a translation:
 * read the form, call better-auth as JSON through identity's one door
 * (`callAuthResponse`), carry its Set-Cookie headers to the browser, redirect.
 *
 * Nothing about §4's custody moves: better-auth is still reached only through identity,
 * and the credential family is still fronted by no pmcp tool. What moved is the URL in
 * the `action=`, and the reason is a content type.
 *
 * /login's three forms, translated. `step` is which challenge card the refusal returns to,
 * and its absence is the credentials card. The whole outcome of a sign-in is in the
 * RESPONSE headers rather than the body, which is why this holds the Response.
 */
async function signInTranslation(
  c: Context,
  endpoint: string,
  body: (form: FormData) => Record<string, unknown>,
  step?: "totp" | "backup-code",
): Promise<Response> {
  // deps: identity.callAuthResponse
  if (crossOrigin(c.req.raw)) return new Response("Forbidden", { status: 403, headers: TEXT });
  const form = await c.req.formData();
  const landing = landingOf(form);
  const answered = await callAuthResponse(c.req.raw, endpoint, body(form));
  if (answered === null || !answered.ok) {
    // §15: one sentence, naming no submitted value — the password reaches no URL, no log
    // and no rendered page — and the SAME sentence whichever half was wrong, which is also
    // the answer that tells a prober nothing about which usernames exist.
    return redirectWith(
      loginUrl({
        step,
        error: step === undefined ? WRONG_CREDENTIALS : WRONG_CODE,
        username: step === undefined ? field(form, "username") : null,
        next: landing,
      }),
      null,
    );
  }
  const outcome = (await answered.json().catch(() => ({}))) as { twoFactorRedirect?: boolean };
  // A two-factor challenge is a SUCCESS with a different destination: better-auth has just
  // set the challenge cookie, and /login's TOTP card is where the code gets typed. Both
  // legs carry the Set-Cookie headers, because on both legs the answer IS a cookie.
  return redirectWith(
    outcome.twoFactorRedirect ? loginUrl({ step: "totp", next: landing }) : landing,
    answered,
  );
}

/**
 * A finished credential POST's redirect, carrying better-auth's own `Set-Cookie` headers
 * on to the browser. That forwarding is the entire reason these routes hold a Response
 * rather than `callAuth`'s parsed body: a sign-in whose cookies are dropped has signed
 * nobody in, and a two-factor challenge whose cookie is dropped cannot be answered.
 */
function redirectWith(to: string, from: Response | null): Response {
  const headers = new Headers({ Location: to });
  for (const cookie of from?.headers.getSetCookie() ?? []) headers.append("Set-Cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/**
 * Where a finished sign-in lands: the form's own `callbackURL` — which is how /login
 * carries a deep link through the round trip (LoginProps.redirectTo) — read through
 * `hubRelative`, the one rule /login's other consumer (the rendered `?next=`) reads too.
 * Anything that rule refuses lands on /apps.
 */
function landingOf(form: FormData): string {
  return hubRelative(field(form, "callbackURL")) ?? paths.apps;
}

/**
 * The origin rule the /login routes stand on, since they stand outside `mutation`'s CSRF
 * gate — there is no session yet to derive a token from, which is exactly why web-pages
 * case 4 excludes /login from its walk. If-present-must-match, the same shape and the same
 * reasoning as the consumer surface's rule (index.ts): a non-browser client sends no
 * Origin and passes, a same-site form post sends the hub's own, and the cross-site post
 * this refuses is the one that would otherwise ride a browser's ambient cookies. The other
 * half of the defense is not code: better-auth's session cookie is SameSite, so a
 * cross-site post carries no session to ride in the first place.
 */
function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin !== env.PUBLIC_ORIGIN;
}

/** The two refusals /login ever shows. Deliberately not better-auth's own wording: these
 *  are the only strings on this surface, and neither distinguishes which half was wrong. */
const WRONG_CREDENTIALS = "That username and password did not match.";
const WRONG_CODE = "That code did not work. Try again.";

/* ------------------------------------------------------------------ *
 * The write side: an op's two answers, and the flash that carries them
 * ------------------------------------------------------------------ */

/**
 * Runs one ops handler and separates the two answers a page has to render differently: a
 * value, or an owner-fixable refusal. Only HubError is caught — a bug inside a handler
 * must reach the composition root as the 500 it is, never a notice telling the owner they
 * asked wrongly (admin.ts draws the same line for the same reason).
 */
async function attempt(work: () => Promise<unknown>): Promise<Attempted> {
  try {
    return { value: await work() };
  } catch (err) {
    if (!(err instanceof HubError)) throw err;
    // §8's field-scoped list, when the refusal carries one: the add-app form reads it to
    // put each sentence under the control it names. `reason` is unchanged for everyone
    // else — every other caller renders the message and nothing more.
    return err.violations === undefined
      ? { reason: err.message }
      : { reason: err.message, violations: [...err.violations] };
  }
}

/** One ops call's answer as the pages read it: a value, or an owner-fixable refusal —
 *  with §8's violation list where the op reported one. */
type Attempted = { value: unknown } | { reason: string; violations?: Violation[] };

/**
 * Where a finished mutation lands: the page it came from, carrying the outcome as one
 * line of props (the redirect-back flash). The op NAME and the refusal's own message
 * ride the query string — both are the owner's own words about their own namespace, and
 * neither is a credential (§15: admin's refusals name fields, never values). THE one
 * builder, for this module's own redirects and for the `{ next }` api.ts's settings writes
 * answer: every key it writes is spelled in `NOTICE_KEYS`, whose copy the client reads the
 * flash back through (`web/src/lib/notice.ts`).
 */
export function noticeUrl(
  back: string,
  op: string,
  outcome: { value: unknown } | { reason: string },
  /** The Password pane's two extra fields (§13); nothing else adds any. */
  extras: Partial<Record<"field" | "signedOut", string>> = {},
): string {
  const fields = new URLSearchParams(
    "value" in outcome ? { [NOTICE_KEYS.done]: op } : { [NOTICE_KEYS.failed]: op },
  );
  // A refusal the HUB made itself carries no upstream sentence (the Password pane's
  // confirm-mismatch check is the only one); the client's `noticeOf` says the words for an
  // absent reason, so an empty one is left off rather than written as an empty message.
  if ("reason" in outcome && outcome.reason !== "") fields.set(NOTICE_KEYS.reason, outcome.reason);
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) fields.set(NOTICE_KEYS[key as "field" | "signedOut"], value);
  }
  // `back` is a pane URL, and a pane URL carries a query of its own (`?sel=`, `?q=`): the
  // flash is APPENDED to it, never a second `?` that would fold the whole selection into
  // one unreadable parameter value.
  return `${back}${back.includes("?") ? "&" : "?"}${fields}`;
}

/* ------------------------------------------------------------------ *
 * The read side
 * ------------------------------------------------------------------ */

/**
 * The context every loader is handed. Built once per request, after the gate: the
 * session's own identity, the render instant, this page's CSRF token and the query string.
 */
async function context(req: Request, session: OwnerSession): Promise<PageContext> {
  return {
    ownerId: session.user.userId,
    username: session.user.username,
    csrfToken: await csrfTokenFor(session.sessionId),
    now: new Date().toISOString(),
    query: new URL(req.url).searchParams,
  };
}

/**
 * The /audit "Export JSONL" response: every audit row matching the link's filters, one JSON
 * object per line, newest first. A thin Response wrapper over
 * audit's streaming export — how the stream is chunked and bounded in memory is
 * audit's owned decision, not repeated here. A serialization of audit_query, not
 * a capability of its own (§8's pinned parity exception); `ownerId` scopes the export
 * to the caller's namespace.
 */
function streamAuditJsonl(
  ownerId: string,
  filters: Extract<AuditExportQuery, { query: unknown }>["query"],
): Response {
  // deps: audit.exportJsonl
  return new Response(exportJsonl(env.DB, ownerId, filters), {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": 'attachment; filename="audit.jsonl"',
    },
  });
}

/* ------------------------------------------------------------------ *
 * Connect, and the small conversions every handler shares
 * ------------------------------------------------------------------ */

/**
 * The Connect/Reconnect redirect. `beginConnect` needs the app ROW — its opaque id is
 * what the state binds to — and no read op reports one (§3: the id is addressing, never
 * display data), which is the one place this module reads registry directly.
 */
async function connectRedirect(
  c: Context,
  session: OwnerSession,
  slug: string,
): Promise<Response> {
  const app: App | null = await new Registry(env.DB).getApp(session.user.userId, slug);
  if (app === null) {
    return c.redirect(noticeUrl(paths.apps, "connect", { reason: "No such app." }), 303);
  }
  const started = await attempt(() => beginConnect(app, { id: session.sessionId }));
  if ("reason" in started) {
    // §13 (37(b)): a refusal lands on the app's own page — Connect is pressed on it (or
    // on /apps/new, whose app now exists), and the list is only for an app that does not.
    return c.redirect(noticeUrl(paths.appPane(slug, "overview"), "connect", started), 303);
  }
  // No audit row of this module's own: the state row upstream just wrote IS the record
  // that a connect started, and `upstream.oauth_connected` records how it ended. A page
  // that wrote its own ledger entry would be the web-only capability §8 forbids.
  return c.redirect(String(started.value), 303);
}

/** What an accepting consent POST chose: the client it is for, as the posted query names it
 *  (only USED once the provider has verified that query), and the agent, resolved. */
type ConsentedAgent = { clientId: string; agentId: string; agentSlug: string };

/**
 * The agent a consent POST chose, resolved by slug scoped to the signed-in owner
 * (`Registry.getAgent`, the same scoping every op uses) — or null for a slug naming no agent
 * in THIS namespace, foreign or invented, which is one refusal, and for a query naming no
 * client. A READ, made before the provider's `/oauth2/consent` is called (brief §5.3), so a
 * refusal here writes nothing anywhere.
 */
async function consentedAgentOf(
  session: OwnerSession,
  oauthQuery: string,
  agentSlug: string,
): Promise<ConsentedAgent | null> {
  const clientId = new URLSearchParams(oauthQuery).get("client_id") ?? "";
  if (clientId === "" || agentSlug === "") return null;
  const agent = await new Registry(env.DB).getAgent(session.user.userId, agentSlug);
  return agent === null ? null : { clientId, agentId: agent.id, agentSlug };
}

/**
 * The consent POST's write half (§19.5 step 4), reached ONLY after the provider's own
 * `/oauth2/consent` has already accepted the request, for an agent `consentedAgentOf`
 * already resolved — this function never runs on a refusal, so it never has to undo one.
 * upsertBinding's own ownership check is a second, independent proof of the scoping.
 * `null` means it succeeded; a Response means the whole POST answers that instead.
 */
async function bindConsentedAgent(session: OwnerSession, chosen: ConsentedAgent): Promise<Response | null> {
  const { clientId, agentSlug } = chosen;
  const bound = await upsertBinding({
    ownerId: session.user.userId,
    clientId,
    agentId: chosen.agentId,
  });
  // Unreachable in practice — `agent` was already scoped to this owner above, which is
  // the one thing upsertBinding refuses on — but the null case is answered rather than
  // asserted away, the same defensive posture domain() takes for a refusal it does not
  // expect either.
  if (bound === null) return new Response("Bad Request", { status: 400, headers: TEXT });
  await record(env.DB, {
    ownerId: session.user.userId,
    principal: formatPrincipal(session.user),
    event: bound.action === "consented" ? "oauth.consented" : "oauth.rebound",
    outcome: "ok",
    detail: { clientId, agent: agentSlug },
  });
  return null;
}

/** A form control's value as a string, or null — a File is not an answer to any field
 *  this module renders, so it is read as absence rather than coerced. */
function field(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

/** A rendered page. Hono JSX components are functions of their props, so a page is its
 *  own document — the shelled ones wrap themselves in Layout, the chromeless ones draw
 *  their own — and rendering is stringifying what the component returned.
 *
 *  This is the hub's ONLY text/html site (the states preview under server/dev has its own,
 *  without the header), which is why the CSP rides here rather than a middleware: the three
 *  directives below need no per-response nonce and touch no inline code, so they close
 *  clickjacking, `<base>` injection and plugin embedding on the whole page surface in one
 *  line. `frame-ancestors 'self'`, not `'none'`: a same-origin embed stays possible and
 *  refusing it would buy nothing. A nonce'd `script-src` is deferred: eight
 *  inline `<script>` sites would each need a per-response nonce threaded through props
 *  that carry none, and 43 inline `style=` attributes would force `'unsafe-inline'` on
 *  `style-src` regardless. */
async function render(node: unknown, status = 200): Promise<Response> {
  const rendered = (node as { toString(): string | Promise<string> }).toString();
  const body = typeof rendered === "string" ? rendered : await rendered;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "frame-ancestors 'self'; base-uri 'self'; object-src 'none'",
      // Every page here is a function of the session (or, for /login, of the challenge
      // cookie): a browser that keeps a copy shows a stale or someone else's page, and a
      // phone that re-shows one instead of asking again looks hung (2026-09-03, live).
      "Cache-Control": "no-store",
    },
  });
}

/**
 * The SPA shell document — what `/apps/*` and `/agents/*` answer with (§13, 2026-09-18),
 * `/audit` since decision 36, and each page family decision 38 moves (`/approvals*` first).
 * `/audit` and `/approvals` pass no `exists`: a window or a list, not a row, is what each
 * addresses, and the record id in `?expand=` is the client's own read to 404.
 *
 * It is a gate and a head, in that order, and the order is the whole point:
 *
 *  1. `requireOwnerSession`, so an unauthenticated deep link is still the 302 to
 *     `/login?next=…` it always was, before any HTML exists;
 *  2. `exists`, so the document-level 404s survive — an unknown slug, another namespace's,
 *     the builtin `pmcp`, and an invalid (agent × app) pair are all the one answer they
 *     were, decided BEFORE the shell is emitted rather than by the client afterwards. A
 *     200 followed by a client-rendered "not found" would make a probe's job easier and
 *     would break every bookmark test;
 *  3. only then the shell.
 *
 * The body is three elements. `<div id="root">` is where the client mounts; the bootstrap is
 * a `<script type="application/json">` carrying the session's CSRF token and the owner's
 * username — the two facts no API can report — beside two pieces of configuration no API
 * reports either (below); and the module script is the client.
 * A JSON island rather than an executable one, deliberately — no page-generated JavaScript
 * runs, so the existing CSP needs no `script-src` relaxation.
 *
 * `title` is the tab's, matching what the page it replaces rendered. The client sets it
 * again on every client-side navigation, because a client navigation changes no head.
 */
function shell(
  title: string,
  /** The document-level 404 check for this route, or absent where the route names no row.
   *  Returning false is `noSuchPage()`; anything it needs it reads itself. */
  exists?: (c: Context, session: OwnerSession) => Promise<boolean>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    // The `/settings` prefix gate's stricter session where it ran, this URL's own otherwise.
    const session = await sessionOf(c);
    if (exists !== undefined && !(await exists(c, session))) return noSuchPage();
    const bootstrap = {
      csrf: await csrfTokenFor(session.sessionId),
      username: session.user.username,
      // The CANONICAL origin, not whatever host this request arrived on: a scoped endpoint
      // URL is a value the owner copies into a bot's configuration, and this is the origin
      // the hub puts on the wire everywhere else (§7's approvalUrl, the CIMD document, the
      // `wss://` the clients derive). So the client never reads `location.origin`.
      origin: env.PUBLIC_ORIGIN,
      // Configuration no API reports, which the approvals page's push control subscribes
      // with (decision 38). "" where the secret is unset (a local `wrangler dev` with no
      // .dev.vars): the client requires the field on every shell, so an absent secret must
      // still be a string — the push control then fails on click, as the server page did
      // with no key, instead of the whole client refusing to mount.
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? "",
    };
    return render(
      SpaShell({ title, bootstrap, stylesheet: paths.stylesheet, appStylesheet: paths.clientStylesheet, script: paths.clientScript }),
    );
  };
}

/**
 * Whether `/apps/<slug>` names a row this owner may see. `getApp` answers null for the
 * builtin, the unknown and the foreign slug alike — one answer, which is exactly what §13
 * pins: a probe learns nothing about another namespace from the 404.
 */
async function appExists(c: Context, session: OwnerSession): Promise<boolean> {
  return (await new Registry(env.DB).getApp(session.user.userId, c.req.param("slug") ?? "")) !== null;
}

/** The same for `/approvals/<id>`: `approvalOf`'s owner-scoped lookup, the one
 *  `GET /api/hub/approvals/<id>` makes too, so the document and the read 404 alike. */
async function approvalExists(c: Context, session: OwnerSession): Promise<boolean> {
  return (await approvalOf(session.user.userId, c.req.param("id") ?? "")) !== null;
}

/** The same for `/agents/<slug>`. The agent listing is the namespace's whole agent set, so a
 *  slug missing from it is unknown or another owner's — indistinguishable, by design. */
async function agentExists(c: Context, session: OwnerSession): Promise<boolean> {
  const slug = c.req.param("slug") ?? "";
  const listed = (await ops.agent_list.handler(session.user.userId, {})) as { agents: { slug: string }[] };
  return listed.agents.some((agent) => agent.slug === slug);
}

/**
 * `/agents/<slug>/apps/<app>`, which is three checks rather than one: the agent is this
 * owner's, the app is too, and — for an ARCHIVED app — the agent holds a grant on it. The
 * last is the one that is easy to lose: an archived app the agent holds nothing on is not a
 * page, but one it DOES hold something on stays reachable, because the set has to remain
 * editable after the app is shelved.
 */
async function agentAppExists(c: Context, session: OwnerSession): Promise<boolean> {
  const agentSlug = c.req.param("slug") ?? "";
  const appSlug = c.req.param("app") ?? "";
  const listed = (await ops.agent_list.handler(session.user.userId, {})) as {
    agents: { slug: string; grants: Record<string, string[]> }[];
  };
  const agent = listed.agents.find((each) => each.slug === agentSlug);
  if (agent === undefined) return false;
  const app = await new Registry(env.DB).getApp(session.user.userId, appSlug);
  if (app === null) return false;
  return !app.archived || (agent.grants[appSlug] ?? []).length > 0;
}

/** The browser surface's own 404: a path under a segment the hub serves, and no page
 *  behind it. One builder, so "no such page" and "not your approval" are one answer. */
function noSuchPage(): Response {
  return new Response("No such page\n", { status: 404, headers: TEXT });
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8" } as const;
const CSS = { "Content-Type": "text/css; charset=utf-8" } as const;
const JAVASCRIPT = { "Content-Type": "text/javascript; charset=utf-8" } as const;
// No cache headers, like every other shell asset: an unversioned URL under a year-long
// `immutable` would make the icon the one asset a deploy could never replace.
const PNG = { "Content-Type": "image/png" } as const;

/**
 * The whole service worker (§13): a push handler and a notificationclick handler, and no
 * fetch handler at all. The payload approvals sends names the app, the tool and the
 * approval id — never arguments (§15) — so what this displays is exactly what it was
 * given, and tapping it opens the decision page.
 */
const SERVICE_WORKER = `self.addEventListener("push", function (event) {
  var payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch (err) { payload = {}; }
  var title = payload.app ? "Approval needed: " + payload.app : "Approval needed";
  var body = payload.tool ? payload.tool + " is waiting for your decision" : "A request is waiting for your decision";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: body,
      tag: payload.approvalId || "approval",
      data: { url: payload.url || "/approvals" },
    }),
  );
});

self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || "/approvals";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (windows) {
      for (var i = 0; i < windows.length; i++) {
        if (windows[i].url === url && "focus" in windows[i]) return windows[i].focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
`;
