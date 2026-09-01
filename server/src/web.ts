// The browser-only surface: server-rendered pages (Hono JSX), the PWA shell, and the
// CSRF discipline for every form the hub serves. Deliberately the shallowest module in
// the server — any depth here would be a web-only capability, which the parity
// invariant (§8) forbids: every mutation a page performs calls an admin ops handler or
// a better-auth endpoint (/login and /settings ride better-auth — the pinned exception),
// so zero business logic lives here. What this module owns and hides: which
// URL renders which template; CSRF issuance, and the ORDER in which a mutation is gated
// (`mutation` — session, form, CSRF, then the body, written once so no handler can be
// spelled without it); where cookie-session gating is applied
// (identity.requireOwnerSession, with recent-auth on /settings — the page AND every
// credential POST it renders, both through that one wrapper); the CREDENTIAL
// TRANSLATION routes, which are the only reason a credential form works at all —
// better-auth's router takes `application/json` and nothing else, so a form posted at one
// of its endpoints is answered 415 and the hub owns those targets instead (see "The
// credential family" below, and pages/model's `paths.auth`); the chunked streaming
// JSONL export framing (never buffered); the web-app manifest and the minimal install+push
// service worker (no SPA, no offline rendering); and the stylesheet the shell links. Every
// clock the pages read is here too: `context` stamps `now` once per request, and /login —
// which has no session and so no context — is stamped at its own handler.
//
// Where the props come from is NOT here: pages/model.ts owns every read AND every
// props-builder, all eight of them, so a handler below is a gate, a loader call, and a
// render — and the ops table is reached through that one seam on the read side and through
// `dispatch` on the write side. better-auth is reached through identity's `callAuth` /
// `callAuthResponse`, its one custodian (§4), and never dialled from this module directly —
// the translation routes above call better-auth exactly the way /settings's loader reads it.
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
import type { AdminOp } from "./admin";
import type { PushSubscriptionJson } from "./approvals";
import { exportJsonl, record } from "./audit";
import { HubError } from "./errors";
import { callAuth, callAuthResponse, formatPrincipal, requireOwnerSession } from "./identity";
import type { OwnerSession } from "./identity";
import { upsertBinding } from "./oauth";
import { Registry } from "./registry";
import type { App } from "./registry";
import { beginConnect } from "./upstream";
import { approvalsFromEnv } from "./wiring";
import { SettingsPage } from "./pages/settings";
import { ApprovalDetail } from "./pages/approval-detail";
import { ApprovalsPage } from "./pages/approvals";
import { AuditPage } from "./pages/audit";
import { ConnectionsPage } from "./pages/connections";
import { ConsentPage } from "./pages/consent";
import { Device } from "./pages/device";
import { Login } from "./pages/login";
import { AppNewPage } from "./pages/app-new";
import { AppsPage } from "./pages/apps";
import {
  settingsProps,
  approvalDetailProps,
  approvalsProps,
  auditFilters,
  auditProps,
  auditQueryOf,
  connectionsProps,
  consentProps,
  deviceProps,
  loginProps,
  paths,
  appNewForm,
  appNewProps,
  appsProps,
} from "./pages/model";
import type { Notice, PageContext, AppNewErrors } from "./pages/model";
// The one stylesheet, as bytes a worker can serve (see the *.css declaration in
// workers-env.d.ts for why an import is how it gets here).
import styles from "./pages/styles.css";

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
 * - /device — the phishing-defense page (RFC 8628 §5.4): shows what the hub knows about
 *   the requesting client and states plainly that approval grants full admin CLI control
 *   of the namespace; the approval POST is CSRF-checked.
 * - /settings — TOTP/passkey enrollment and removal, active sessions; requires recent
 *   authentication (§4), and its mutations ride better-auth's own endpoints — the
 *   pinned parity exception: no pmcp tool ever reaches credentials.
 * - /audit — read-only view over audit_query with its exact filters; desktop page
 *   numbers and mobile "Load more" are two presentations of the one { rows, total }
 *   offset/limit contract, and a row's client session id links back here as
 *   ?session=…. "Export JSONL" streams via streamAuditJsonl. No mutations, no CSRF.
 * - /approvals, /approvals/<id> — pending requests and decision history; approve and
 *   reject POST into the approval_decide admin op; the per-browser "Enable
 *   notifications" control POSTs the browser's push subscription to
 *   approvals.subscribePush (approvals owns Web Push; this module only subscribes).
 * - /apps, /apps/new — app management fronting the app_* admin ops;
 *   Connect/Reconnect redirect into the upstream module's OAuth initiation.
 * - /oauth/consent — §19.5's inbound-OAuth consent screen: the provider redirects an
 *   authenticated, uncovered authorization request here with a signed query the page
 *   echoes back verbatim; the POST verifies with the provider's own /oauth2/consent
 *   BEFORE writing oauth_binding, so a refused request writes nothing.
 * - /oauth/connections — the bindings the consent screen produced, fronting
 *   connection_list/connection_revoke; Revoke rides the same generic dispatch as
 *   /apps' own mutations.
 * - /manifest.webmanifest, /sw.js, /styles.css — the PWA shell: installability, push,
 *   and the one stylesheet. The service worker handles push + notificationclick
 *   (opening /approvals/<id>) and never intercepts navigation (the no-SPA pin, §13).
 */
export function pageRoutes(): PageRouter {
  // deps: hono · identity.requireOwnerSession · admin.ops · pages/model (the loaders) ·
  // approvals.subscribePush · upstream.beginConnect · csrfTokenFor · checkCsrf ·
  // streamAuditJsonl
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

  app.get(paths.device, async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    return render(Device(await deviceProps(ctx, c.req.raw)));
  });

  // §13: approving grants full admin CLI control of the namespace, so the decision is a
  // CSRF-checked POST — into better-auth's own device endpoints, which own the code's
  // whole lifecycle (§4). No ops handler fronts them and none should: the credential
  // family is pinned outside the parity invariant (§8).
  app.post(
    paths.deviceDecide,
    mutation(async (c, _session, form) => {
      const approved = field(form, "decision") === "approve";
      const answered = await callAuth(c.req.raw, approved ? "/device/approve" : "/device/deny", {
        userCode: field(form, "user_code") ?? "",
      });
      if (answered === null) {
        return c.redirect(`${paths.device}?error=${encodeURIComponent("That code could not be decided.")}`, 303);
      }
      return c.redirect(`${paths.device}?decided=${approved ? "approved" : "denied"}`, 303);
    }),
  );

  /* --------------------------------- /settings --------------------------------- */

  // §4/§13's recent-auth surface, whose other half is every credential POST below: a
  // session minted by the device flow never qualifies, and a browser session older than
  // better-auth's freshness window is sent through a fresh sign-in. Both refusals are
  // identity's, thrown as a redirect.
  app.get(paths.settings, async (c) => {
    const session = await requireOwnerSession(c.req.raw, { recent: true });
    const ctx = await context(c.req.raw, session);
    return render(SettingsPage(await settingsProps(ctx, c.req.raw)));
  });

  // /settings's credential forms, translated the same way /login's are and gated the way
  // /settings itself is: each is a `credential`, so session, RECENT AUTHENTICATION (§4) and
  // CSRF are all proven before any of this runs. The pinned parity exception is untouched —
  // none of them names an op, and none of them reaches D1 except through better-auth (§8).
  app.post(
    paths.auth.totpEnable,
    credential("/two-factor/enable", "two_factor_enable", (form) => ({
      password: field(form, "password") ?? "",
    })),
  );

  app.post(
    paths.auth.totpDisable,
    credential("/two-factor/disable", "two_factor_disable", (form) => ({
      password: field(form, "password") ?? "",
    })),
  );

  app.post(
    paths.auth.backupCodesGenerate,
    credential("/two-factor/generate-backup-codes", "backup_codes_generate", (form) => ({
      password: field(form, "password") ?? "",
    })),
  );

  app.post(
    paths.auth.passkeyDelete,
    credential("/passkey/delete-passkey", "passkey_remove", (form) => ({
      id: field(form, "id") ?? "",
    })),
  );

  // The one translation that is more than a rename: the page knows a session by the `id`
  // its listing shows, and better-auth's revoke takes the session's TOKEN. Reading the
  // listing again here is what maps one to the other — and is also why SettingsProps'
  // session shape can keep leaving `token` out of the props entirely (§15).
  app.post(
    paths.auth.sessionRevoke,
    credential("/revoke-session", "session_revoke", async (form, req) => ({
      token: (await sessionTokenFor(req, field(form, "id") ?? "")) ?? "",
    })),
  );

  /* ---------------------------------- /audit ---------------------------------- */

  app.get(paths.audit, async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    return render(AuditPage(await auditProps(ctx)));
  });

  // The same read, framed as lines instead of a page (§8's pinned parity exception):
  // same filters, same order, and never a capability of its own.
  app.get(paths.auditExport({}), async (c) => {
    const session = await requireOwnerSession(c.req.raw);
    const ctx = await context(c.req.raw, session);
    return streamAuditJsonl(session.user.userId, auditQueryOf(auditFilters(ctx)));
  });

  /* -------------------------------- /approvals -------------------------------- */

  app.get(paths.approvals, async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    return render(ApprovalsPage(await approvalsProps(ctx)));
  });

  // The browser's own PushSubscription, handed to the module that owns Web Push. Not an
  // ops handler and never a tool: what a browser subscribes is a property of THAT
  // browser, which no CLI or agent can hold or replay (§13).
  app.post(
    paths.approvalsPush,
    mutation(async (_c, session, form) => {
      const subscription = subscriptionOf(field(form, "subscription"));
      if (subscription === null) return new Response("Bad Request", { status: 400, headers: TEXT });
      // No push transport wired: subscribing sends nothing (approvals.approvalsFromEnv).
      await approvalsFromEnv().subscribePush(session.user.userId, subscription);
      return new Response(null, { status: 204 });
    }),
  );

  // Registered before the generic ops route below, so a decision on the id in the query
  // is never read as an op named "push".
  app.post("/approvals/:op", dispatch(paths.approvals));

  // Last under /approvals, so the two POST targets above own their own paths: a GET here
  // is an id, and an id that is not this owner's is not an id at all (§13).
  app.get("/approvals/:id", async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    const props = await approvalDetailProps(ctx, c.req.param("id"));
    // An id in another namespace is not in this owner's listing at all, so it answers
    // exactly like an id that never existed (§13).
    if (props === null) return noSuchPage();
    return render(ApprovalDetail(props));
  });

  /* -------------------------------- /apps --------------------------------- */

  app.get(paths.apps, async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    return render(AppsPage(await appsProps(ctx)));
  });

  app.get(paths.appNew, async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    return render(
      AppNewPage(appNewProps(ctx, { kind: "form", form: appNewForm(ctx.query), errors: {} })),
    );
  });

  // The one mutation that does not redirect back, because its answer cannot survive a
  // redirect: a tunneled create is followed by the token_issue that gives the bot its
  // credential, and §4 shows that plaintext exactly once — in this response, never in a
  // URL (§15). An `auth: oauth` create redirects into consent instead (§7).
  app.post(
    paths.appCreate,
    mutation(async (c, session, form) => {
      const ctx = await context(c.req.raw, session);
      const draft = appNewForm(formQuery(form));
      const created = await attempt(() =>
        ops.app_create.handler(session.user.userId, {
          slug: draft.slug,
          kind: draft.kind,
          name: draft.name,
          // Proxy-only fields are rejected on a tunneled create (§8), so they are sent
          // only where they mean something. `authMode` is the control's name and `auth`
          // is the op's — the one place the two spellings meet.
          ...(draft.kind === "proxy" ? { endpoint: draft.endpoint, auth: draft.authMode } : {}),
        }),
      );
      if ("reason" in created) {
        return render(
          AppNewPage(
            appNewProps(ctx, { kind: "form", form: draft, errors: createErrors(created.reason) }),
          ),
          400,
        );
      }
      if (draft.kind === "proxy" && draft.authMode === "oauth") {
        return connectRedirect(c, session, draft.slug);
      }
      // A proxied app has nothing that connects, so it has no token to reveal (§6).
      const minted =
        draft.kind === "tunnel"
          ? await attempt(() =>
              ops.token_issue.handler(session.user.userId, { kind: "app", slug: draft.slug }),
            )
          : null;
      return render(
        AppNewPage(
          appNewProps(ctx, {
            kind: "created",
            slug: draft.slug,
            name: draft.name === "" ? draft.slug : draft.name,
            token: minted !== null && "value" in minted ? tokenOf(minted.value) : null,
          }),
        ),
      );
    }),
  );

  // Connect and Reconnect: §8's one browser-only interaction, which is why it fronts no
  // tool. Everything it does — discovery, client identity, the single-use state row —
  // belongs to upstream; this hands it the app and the session and redirects.
  app.post(
    paths.appConnect(""),
    mutation((c, session) =>
      connectRedirect(c, session, new URL(c.req.url).searchParams.get("slug") ?? ""),
    ),
  );

  app.post("/apps/:op", dispatch(paths.apps));

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
  // (§19.5 step 4): the provider's own `/oauth2/consent` is called FIRST, carrying the
  // session, and only on ITS success does anything land in `oauth_binding` or the ledger —
  // a provider refusal (an edited `oauth_query`, an expired one) writes nothing at all.
  app.post(
    paths.oauthConsent,
    mutation(async (c, session, form) => {
      const oauthQuery = field(form, "oauth_query") ?? "";
      const accept = field(form, "decision") === "accept";
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
      if (accept) {
        const refused = await bindConsentedAgent(session, oauthQuery, field(form, "agent") ?? "");
        if (refused !== null) return refused;
      }
      // The hub performs the final browser redirect (§19.5 step 4) — the provider already
      // validated `redirect_uri` at authorize time (§19.3), so nothing here re-checks it.
      return c.redirect(redirectUri, 303);
    }),
  );

  /* ------------------------------- /oauth/connections --------------------------- */

  app.get(paths.oauthConnections, async (c) => {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    return render(ConnectionsPage(await connectionsProps(ctx)));
  });

  // Revoke, fronting connection_revoke exactly like /apps fronts its own ops (§8's
  // parity direction B): the final path segment names the op, `id` rides the query string.
  app.post("/oauth/connections/:op", dispatch(paths.oauthConnections));

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
        icons: [],
      },
      { headers: { "Content-Type": "application/manifest+json; charset=utf-8" } },
    ),
  );

  // Push and notificationclick, and NOTHING else: no fetch handler at all, which is the
  // no-SPA pin (§13) as code rather than as a promise — this worker cannot intercept a
  // navigation because it never registers to.
  app.get(paths.serviceWorker, () => new Response(SERVICE_WORKER, { headers: JAVASCRIPT }));

  app.get(paths.stylesheet, () => new Response(styles, { headers: CSS }));

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
 * `gate` is what a stricter mutation asks the session gate for, and today that is §4's
 * recent authentication — `credential` below passes it, so every credential POST is held
 * to the same freshness /settings's own render is. It rides HERE rather than at those five
 * routes because the gate is this wrapper's call to make: a route that named its own would
 * be a second place the order is written, and a route that forgot is the day-old-cookie
 * takeover §4 exists to refuse.
 *
 * GETs and the OAuth callback are outside its scope: a read mutates nothing, and the
 * callback's replay defense is the single-use `state`, owned by upstream.
 */
function mutation(
  handle: (c: Context, session: OwnerSession, form: FormData) => Promise<Response>,
  gate?: { recent: boolean },
): (c: Context) => Promise<Response> {
  // deps: identity.requireOwnerSession · checkCsrf
  return async (c) => {
    const session = await requireOwnerSession(c.req.raw, gate);
    const form = await c.req.formData();
    const refused = await checkCsrf(session.sessionId, form);
    if (refused !== null) return refused;
    return handle(c, session, form);
  };
}

/**
 * The check itself: the submitted form's CSRF field against the cookie session that
 * rendered it. Null to proceed, or the 403 `mutation` returns as-is. Separate from the
 * wrapper because it is the decision, and the wrapper is the ordering.
 */
async function checkCsrf(sessionToken: string, form: FormData): Promise<Response | null> {
  // deps: csrfTokenFor
  const presented = field(form, "csrf");
  const expected = await csrfTokenFor(sessionToken);
  if (presented !== null && presented.length === expected.length && presented === expected) return null;
  return new Response("Forbidden", { status: 403, headers: TEXT });
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
 * /settings's credential forms — the same translation with a session behind it, so it is a
 * `mutation` like every other page POST and the gate order is not restated here either.
 * `op` is the name the redirect-back flash reports the outcome under, exactly as an
 * ops-backed mutation reports its op key.
 *
 * ONE thing it asks of that gate beyond the ordinary: `recent: true`. §4 puts recent
 * authentication on credential MANAGEMENT, not on the page that displays it, so gating only
 * the /settings render would leave a day-old cookie plus a password able to enrol a second
 * factor or revoke a session — and a browser posts these targets directly. It is spelled
 * once, here, because every credential route is spelled through this function: that is what
 * makes "all of them" true of the family rather than of the five that exist today.
 */
function credential(
  endpoint: string,
  op: string,
  body: (form: FormData, req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>,
): (c: Context) => Promise<Response> {
  // deps: mutation · identity.callAuthResponse
  return mutation(async (c, _session, form) => {
    const answered = await callAuthResponse(c.req.raw, endpoint, await body(form, c.req.raw));
    const succeeded = answered !== null && answered.ok;
    return redirectWith(
      noticeUrl(paths.settings, op, succeeded ? { value: null } : { reason: await refusalOf(answered) }),
      succeeded ? answered : null,
    );
  }, { recent: true });
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
 * carries a deep link through the round trip (LoginProps.redirectTo) — accepted only as a
 * hub-relative path. A form field is a caller's input, and honouring an absolute one would
 * make /login an open redirect for anyone who can get a browser to post here.
 */
function landingOf(form: FormData): string {
  const target = field(form, "callbackURL") ?? "";
  return target.startsWith("/") && !target.startsWith("//") ? target : paths.apps;
}

/** /login under a set of query fields; an absent or empty one leaves no trace. */
function loginUrl(fields: Record<string, string | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined || value === "") continue;
    search.set(name, value);
  }
  const rendered = search.toString();
  return rendered === "" ? paths.login : `${paths.login}?${rendered}`;
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

/** The one line a refused credential change shows: better-auth's own `message` and nothing
 *  else out of the body. A message names a field ("[body.password] Invalid input"), never a
 *  submitted value — and the rest of the body is not a notice's business (§15). */
async function refusalOf(response: Response | null): Promise<string> {
  const body = (await response?.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : "The change was refused.";
}

/**
 * The session TOKEN behind one of /settings's listed session ids. The page knows a session
 * by the id its listing shows and better-auth's revoke takes the token, so the listing is
 * read again here to pair them — which is what lets SettingsProps' session shape keep
 * leaving `token` out of the props entirely (§15: a shape that named it is one careless
 * spread away from rendering it). The token exists in this function and dies with it.
 */
async function sessionTokenFor(req: Request, id: string): Promise<string | null> {
  // deps: identity.callAuth
  const listed = await callAuth<{ id: string; token: string }[]>(req, "/list-sessions");
  if (!Array.isArray(listed)) return null;
  return listed.find((session) => session.id === id)?.token ?? null;
}

/** The two refusals /login ever shows. Deliberately not better-auth's own wording: these
 *  are the only strings on this surface, and neither distinguishes which half was wrong. */
const WRONG_CREDENTIALS = "That username and password did not match.";
const WRONG_CODE = "That code did not work. Try again.";

/* ------------------------------------------------------------------ *
 * The write side: one dispatch into the ops table
 * ------------------------------------------------------------------ */

/**
 * Every ops-backed page mutation, as one handler. The op is named by the final path
 * segment and its arguments are the query string plus the form's own controls (`paths`
 * states that convention and §8's parity direction B is what it buys), so this function
 * knows no tool names at all — which is what makes "a page can do nothing a tool cannot"
 * structural rather than promised. It is a `mutation` like every other, so the gate order
 * is not restated here either.
 */
function dispatch(back: string) {
  return mutation(async (c, session, form) => {
    const name = c.req.param("op") ?? "";
    const op = opNamed(name);
    if (op === undefined) return new Response("No such action\n", { status: 404, headers: TEXT });
    const input = { ...queryFields(c.req.raw), ...formFields(form) };
    const outcome = await attempt(() => op.handler(session.user.userId, input));
    return c.redirect(noticeUrl(back, name, outcome), 303);
  });
}

/** An op by name — `hasOwnProperty` so a form action naming `toString` names no tool. */
function opNamed(name: string): AdminOp | undefined {
  return Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
}

/**
 * Runs one ops handler and separates the two answers a page has to render differently: a
 * value, or an owner-fixable refusal. Only HubError is caught — a bug inside a handler
 * must reach the composition root as the 500 it is, never a notice telling the owner they
 * asked wrongly (admin.ts draws the same line for the same reason).
 */
async function attempt(
  work: () => Promise<unknown>,
): Promise<{ value: unknown } | { reason: string }> {
  try {
    return { value: await work() };
  } catch (err) {
    if (err instanceof HubError) return { reason: err.message };
    throw err;
  }
}

/**
 * Where a finished mutation lands: the page it came from, carrying the outcome as one
 * line of props (the redirect-back flash). The op NAME and the refusal's own message
 * ride the query string — both are the owner's own words about their own namespace, and
 * neither is a credential (§15: admin's refusals name fields, never values).
 */
function noticeUrl(back: string, op: string, outcome: { value: unknown } | { reason: string }): string {
  if ("value" in outcome) return `${back}?done=${encodeURIComponent(op)}`;
  return `${back}?failed=${encodeURIComponent(op)}&reason=${encodeURIComponent(outcome.reason)}`;
}

/** The flash the redirect above left, read back on the next render. */
function noticeOf(query: URLSearchParams): Notice | null {
  const done = query.get("done");
  if (done !== null) return { tone: "success", message: `${humanize(done)} done.` };
  const failed = query.get("failed");
  if (failed === null) return null;
  return {
    tone: "danger",
    title: `${humanize(failed)} failed`,
    message: query.get("reason") ?? "The change was refused.",
  };
}

/** `app_archive` → "App archive" — an op key as a sentence's first words. */
function humanize(op: string): string {
  const words = op.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/* ------------------------------------------------------------------ *
 * The read side
 * ------------------------------------------------------------------ */

/**
 * The context every loader is handed. Built once per request, after the gate: the
 * session's own identity, the render instant, this page's CSRF token, the flash the last
 * mutation left, and the query string.
 */
async function context(req: Request, session: OwnerSession): Promise<PageContext> {
  const query = new URL(req.url).searchParams;
  return {
    ownerId: session.user.userId,
    username: session.user.username,
    sessionId: session.sessionId,
    csrfToken: await csrfTokenFor(session.sessionId),
    now: new Date().toISOString(),
    notice: noticeOf(query),
    query,
  };
}

/**
 * The /audit "Export JSONL" response: every audit row matching the page's current
 * filters, one JSON object per line, newest first. A thin Response wrapper over
 * audit's streaming export — how the stream is chunked and bounded in memory is
 * audit's owned decision, not repeated here. A serialization of audit_query, not
 * a capability of its own (§8's pinned parity exception); `ownerId` scopes the export
 * to the caller's namespace.
 */
function streamAuditJsonl(ownerId: string, filters: ReturnType<typeof auditQueryOf>): Response {
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
    return c.redirect(noticeUrl(paths.apps, "connect", started), 303);
  }
  // No audit row of this module's own: the state row upstream just wrote IS the record
  // that a connect started, and `upstream.oauth_connected` records how it ended. A page
  // that wrote its own ledger entry would be the web-only capability §8 forbids.
  return c.redirect(String(started.value), 303);
}

/**
 * The consent POST's write half (§19.5 step 4), reached ONLY after the provider's own
 * `/oauth2/consent` has already accepted the request — this function never runs on a
 * refusal, so it never has to undo one. Resolves the CHOSEN agent by slug scoped to the
 * signed-in owner (`Registry.getAgent`, the same scoping every op uses) — a slug naming
 * no agent in THIS namespace, foreign or invented, is one refusal, and upsertBinding's own
 * ownership check is the second independent proof of the same fact. `null` means it
 * succeeded; a Response means the whole POST answers that instead, writing nothing.
 */
async function bindConsentedAgent(
  session: OwnerSession,
  oauthQuery: string,
  agentSlug: string,
): Promise<Response | null> {
  const clientId = new URLSearchParams(oauthQuery).get("client_id") ?? "";
  const agent =
    clientId === "" || agentSlug === ""
      ? null
      : await new Registry(env.DB).getAgent(session.user.userId, agentSlug);
  if (agent === null) return new Response("Bad Request", { status: 400, headers: TEXT });
  const bound = await upsertBinding({
    ownerId: session.user.userId,
    clientId,
    agentId: agent.id,
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

/** The form's own fields as an ops input, minus the CSRF token — which is this module's
 *  business and no op's. Values are strings because every page control is a string
 *  control; an op that took a number would fail its own validation here, loudly. */
function formFields(form: FormData): Record<string, string> {
  const fields: Record<string, string> = {};
  form.forEach((value, name) => {
    if (name === "csrf" || typeof value !== "string") return;
    fields[name] = value;
  });
  return fields;
}

/** The action's query string as ops input — the other half of the same convention. */
function queryFields(req: Request): Record<string, string> {
  return Object.fromEntries(new URL(req.url).searchParams.entries());
}

/** A submitted form as a query bag, so the add-app form and the /apps/new link
 *  are read back by exactly one function (pages/model's appNewForm). */
function formQuery(form: FormData): URLSearchParams {
  return new URLSearchParams(Object.entries(formFields(form)));
}

/** A refused create, put under the control it is about — the field-scoped messages the
 *  form draws in red. admin's refusals name the field in quotes, which is what this reads. */
function createErrors(reason: string): AppNewErrors {
  for (const key of ["slug", "name", "endpoint"] as const) {
    if (reason.includes(`"${key}"`)) return { [key]: reason };
  }
  return { form: reason };
}

/** token_issue's plaintext, read out of the op's own result and never anywhere else. */
function tokenOf(value: unknown): string | null {
  const token = (value as { token?: unknown }).token;
  return typeof token === "string" ? token : null;
}

/** The browser's PushSubscription JSON, as the control POSTs it. Shape-checked here
 *  because it is a browser's word: approvals stores it verbatim and must not store junk. */
function subscriptionOf(raw: string | null): PushSubscriptionJson | null {
  if (raw === null) return null;
  const parsed = jsonOrNull(raw) as PushSubscriptionJson | null;
  if (parsed === null || typeof parsed.endpoint !== "string") return null;
  const keys = parsed.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  if (typeof keys?.p256dh !== "string" || typeof keys.auth !== "string") return null;
  return { endpoint: parsed.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Parsed, or null — a browser's field is a caller's input, and malformed JSON in it is
 *  a 400 rather than a 500. */
function jsonOrNull(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** A rendered page. Hono JSX components are functions of their props, so a page is its
 *  own document — the shelled ones wrap themselves in Layout, the chromeless ones draw
 *  their own — and rendering is stringifying what the component returned. */
async function render(node: unknown, status = 200): Promise<Response> {
  const rendered = (node as { toString(): string | Promise<string> }).toString();
  const body = typeof rendered === "string" ? rendered : await rendered;
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

/** The browser surface's own 404: a path under a segment the hub serves, and no page
 *  behind it. One builder, so "no such page" and "not your approval" are one answer. */
function noSuchPage(): Response {
  return new Response("No such page\n", { status: 404, headers: TEXT });
}

const TEXT = { "Content-Type": "text/plain; charset=utf-8" } as const;
const CSS = { "Content-Type": "text/css; charset=utf-8" } as const;
const JAVASCRIPT = { "Content-Type": "text/javascript; charset=utf-8" } as const;

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
