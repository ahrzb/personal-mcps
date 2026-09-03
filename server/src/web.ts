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
import { APP_PANES } from "./app-routes";
import type { AppPane } from "./app-routes";
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
import { ConsentPage } from "./pages/consent";
import { Device } from "./pages/device";
import { Login } from "./pages/login";
import { AppDetailPage } from "./pages/app-detail";
import { AppNewPage } from "./pages/app-new";
import { AppsPage } from "./pages/apps";
import {
  settingsProps,
  approvalDetailProps,
  approvalsProps,
  auditFilters,
  auditProps,
  auditQueryOf,
  consentProps,
  deviceProps,
  enrollmentOf,
  hubRelative,
  loginProps,
  loginUrl,
  NOTICE_KEYS,
  paths,
  revealedCodesOf,
  SETTINGS_PANES,
  appDetailProps,
  appNewForm,
  appNewProps,
  appsProps,
} from "./pages/model";
import type {
  AppDetailPane,
  Notice,
  PageContext,
  AppNewErrors,
  PasswordField,
  SettingsProps,
} from "./pages/model";
// The one stylesheet, as bytes a worker can serve (see the *.css declaration in
// workers-env.d.ts for why an import is how it gets here).
import styles from "./pages/styles.css";

/**
 * The one thing a request carries from a gate to the handler under it: the session the
 * gate ALREADY resolved (`sessionOf` reads it back). Declared on hono's own variable map
 * rather than as an app-wide type parameter so that no handler, no `mutation` and no
 * `dispatch` signature below grows a generic to say it.
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
 * - /oauth/connections — a 301 to /settings/clients, where §13 re-homed the bindings the
 *   consent screen produced. connection_list/connection_revoke are fronted by that pane;
 *   Revoke rides the same generic dispatch as /apps' own mutations, under /settings/clients.
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

  // §13's "A page's gate is every pane's gate", as ONE PREFIX RULE rather than a check per
  // route: every pane, every credential POST and both ops-backed dispatchers below are
  // behind this middleware, so a route added under /settings cannot be added ungated.
  // §4's recent-auth surface is what it proves: a session minted by the device flow never
  // qualifies, and a browser session older than better-auth's freshness window is sent
  // through a fresh sign-in. Both refusals are identity's, thrown as a redirect. It reads
  // a COOKIE and never `Authorization` — that is requireOwnerSession's own contract, and
  // it is why a bearer on a page route is not a credential but simply nothing.
  // The resolved session is STASHED rather than discarded: `sessionOf` hands it to the
  // pane handlers and to `mutation`, so the gate's decision — a better-auth session read
  // plus §4's freshness read — is made once per request instead of being made here and
  // then made again by everything this wraps.
  const settingsGate = async (c: Context, next: () => Promise<void>) => {
    c.set("ownerSession", await requireOwnerSession(c.req.raw, { recent: true }));
    await next();
  };
  app.use(paths.settings, settingsGate);
  app.use(`${paths.settings}/*`, settingsGate);

  // §13's six panes, one URL each. The landing pane is Password and has no alias — the
  // `/settings/password` a reader might guess is answered by this app's own 404, because
  // no route claims it. Each handler differs from the next in one word, so the pane is a
  // parameter of the loader rather than of a page (pages/model's `settingsProps`).
  for (const { pane, href } of SETTINGS_PANES) {
    app.get(href, async (c) => {
      const ctx = await context(c.req.raw, await sessionOf(c));
      return render(SettingsPage(await settingsProps(ctx, c.req.raw, pane)));
    });
  }

  // /settings's credential forms, translated the same way /login's are and gated the way
  // /settings itself is: each is a `credential`, so session, RECENT AUTHENTICATION (§4) and
  // CSRF are all proven before any of this runs. The pinned parity exception is untouched —
  // none of them names an op, and none of them reaches D1 except through better-auth (§8).
  // Each names the PANE that drew its form, because that is where its notice has to land
  // (§13: "mutations belong to a pane") — the page root is one pane's answer, not every
  // pane's.
  app.post(
    paths.auth.totpEnable,
    credential(
      paths.settingsTwoFactor,
      "/two-factor/enable",
      "two_factor_enable",
      (form) => ({ password: field(form, "password") ?? "" }),
      // better-auth mints the secret AND the ten codes in this one answer and will never
      // repeat either — a second enable rotates the secret, and nothing can show the codes
      // again (§4) — so the answer IS the page: 200 in place with both, and no Location for
      // either to ride (§15). It sets no cookie, so rendering here is safe (`credential`'s
      // constraint). A refusal carries no enrolment and its form posted none, so there is
      // nothing to redraw and the flash answers instead.
      async (req, session, _form, outcome) => {
        if (!outcome.ok) return null;
        const enrollment = enrollmentOf(String(outcome.answer.totpURI ?? ""), null);
        return enrollment === null
          ? null
          : settingsTwoFactorPage(req, session, {
              enrollment,
              revealedBackupCodes: answeredCodes(outcome.answer),
            });
      },
    ),
  );

  // The enrolment card's own target: the code typed into the six boxes, checked by the same
  // better-auth endpoint /login's challenge card posts to. It is here rather than there
  // because /login's translation is not a `credential` — this one inherits the CSRF check
  // and §4's freshness, and answers a wrong code in place (pages/model's
  // `paths.auth.totpVerifySettings`).
  app.post(
    paths.auth.totpVerifySettings,
    credential(
      paths.settingsTwoFactor,
      "/two-factor/verify-totp",
      "two_factor_enable",
      (form) => ({ code: field(form, "code") ?? "" }),
      async (req, session, form, outcome) => {
        // SUCCESS keeps the 303, and it is the one arm in this family that must: better-auth
        // has just deleted the session this ran under and minted a new one, so a render here
        // would read the props with a dead cookie. The flash says what happened on the pane
        // the NEW cookie draws, under the op key the journey started with.
        if (outcome.ok) return null;
        // A refused code redraws the SAME enrolment. It cannot be re-derived — get-totp-uri
        // wants a password this card has not got, and a second enable would rotate the
        // secret the owner has already scanned — so the card carries it forward in its own
        // hidden fields, and both are validated before they are drawn again because both are
        // hand-postable. Neither ever touches a URL, which is what §15 forbids.
        const enrollment = enrollmentOf(field(form, "totpuri") ?? "", outcome.message);
        return enrollment === null
          ? null
          : settingsTwoFactorPage(req, session, {
              enrollment,
              revealedBackupCodes: postedCodes(field(form, "codes") ?? ""),
            });
      },
    ),
  );

  app.post(
    paths.auth.totpDisable,
    credential(paths.settingsTwoFactor, "/two-factor/disable", "two_factor_disable", (form) => ({
      password: field(form, "password") ?? "",
    })),
  );

  app.post(
    paths.auth.backupCodesGenerate,
    credential(
      paths.settingsTwoFactor,
      "/two-factor/generate-backup-codes",
      "backup_codes_generate",
      (form) => ({ password: field(form, "password") ?? "" }),
      // The same seam as enable's, with the smaller overlay: a fresh set is revealed exactly
      // once and a URL is not where it can be revealed (§15). This endpoint sets no cookie,
      // so the in-place answer is safe here by `credential`'s own rule; a wrong password has
      // no set to show and takes the flash.
      async (req, session, _form, outcome) => {
        const revealed = outcome.ok ? answeredCodes(outcome.answer) : null;
        return revealed === null
          ? null
          : settingsTwoFactorPage(req, session, { enrollment: null, revealedBackupCodes: revealed });
      },
    ),
  );

  app.post(
    paths.auth.passkeyDelete,
    credential(paths.settingsPasskeys, "/passkey/delete-passkey", "passkey_remove", (form) => ({
      id: field(form, "id") ?? "",
    })),
  );

  // The one translation that is more than a rename: the page knows a session by the `id`
  // its listing shows, and better-auth's revoke takes the session's TOKEN. Reading the
  // listing again here is what maps one to the other — and is also why SettingsProps'
  // session shape can keep leaving `token` out of the props entirely (§15).
  app.post(
    paths.auth.sessionRevoke,
    credential(paths.settingsSessions, "/revoke-session", "session_revoke", async (form, req) => ({
      token: (await sessionTokenFor(req, field(form, "id") ?? "")) ?? "",
    })),
  );

  // §13's **Revoke all others** — better-auth's own endpoint, which keeps the session
  // that asked and deletes every other. The opposite contract from the Password pane's
  // checkbox, and deliberately not unified with it.
  app.post(
    paths.auth.revokeOtherSessions,
    credential(paths.settingsSessions, "/revoke-other-sessions", "revoke_other_sessions", () => ({})),
  );

  // §13's **Update password** — a `credential` in every respect its five siblings are
  // (recent auth, CSRF, better-auth's own Set-Cookie carried on to the browser exactly as
  // a sign-in carries it), and spelled out here rather than through `credential` because
  // three of §13's sentences about it are about the ANSWER rather than the call: the hub
  // pre-checks new ≠ confirm (better-auth's body has no confirm field, so nobody else
  // can), better-auth's error CODE picks the control the refusal is drawn beside, and `N`
  // is counted before the call — after a successful revoke there is no listing left to
  // count and no cookie left to ask with.
  app.post(
    paths.auth.changePassword,
    mutation(
      async (c, _session, form) => {
        const newPassword = field(form, "newPassword") ?? "";
        // The ONE check the hub makes itself, and it is made BEFORE the call: a
        // mistyped confirmation must not reach better-auth, which would happily accept
        // the password the owner did not mean to set (§13).
        if (newPassword !== (field(form, "confirmPassword") ?? "")) {
          // No `reason`: the hub's own refusal has no upstream sentence, and §13 draws
          // this one beside the control the `field` names (noticeUrl says the rest).
          return redirectWith(
            noticeUrl(paths.settingsPane("password"), CHANGE_PASSWORD, { reason: "" }, { field: "confirmPassword" }),
            null,
          );
        }
        // A browser sends an unticked box as nothing at all, which is what makes its
        // presence the checkbox's own state and not a second control (§13's default-on).
        const revokeOtherSessions = field(form, "revokeOtherSessions") !== null;
        const others = revokeOtherSessions ? await otherSessionCount(c.req.raw) : null;
        const answered = await callAuthResponse(c.req.raw, "/change-password", {
          currentPassword: field(form, "currentPassword") ?? "",
          newPassword,
          revokeOtherSessions,
        });
        if (answered === null || !answered.ok) {
          const refusal = await refusalOf(answered);
          const named = PASSWORD_REFUSAL_FIELD[refusal.code];
          return redirectWith(
            // Every refusal still carries the ordinary notice — that is the shell's
            // contract for a redirect-back and §13's "anything else" arm. What a MAPPED
            // code adds is the control: the notice keeps better-auth's own words and the
            // §13 sentence is drawn beside the field, so neither is spelled twice.
            noticeUrl(paths.settingsPane("password"), CHANGE_PASSWORD, { reason: refusal.message }, {
              ...(named === undefined ? {} : { field: named }),
            }),
            null,
          );
        }
        return redirectWith(
          noticeUrl(paths.settingsPane("password"), CHANGE_PASSWORD, { value: null }, {
            ...(others === null ? {} : { signedOut: String(others) }),
          }),
          answered,
        );
      },
      { recent: true },
    ),
  );

  // The two ops-backed panes' dispatchers (§13's Tokens and Connected clients), each
  // under its own pane's prefix so the redirect-back lands where the form was drawn.
  // They ride the SAME generic dispatch /apps' mutations do — the final segment names the
  // op — and the prefix gate above holds them to /settings's stricter regime.
  app.post(`${paths.settingsTokens}/:op`, dispatch(paths.settingsTokens));
  app.post(`${paths.settingsClients}/:op`, dispatch(paths.settingsClients));

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

  // §13's eight panes behind one rail, as two routes: the page root renders the LANDING
  // pane (Tools) and each of the seven others answers at its own URL. Registered after
  // the static segments above, which is what keeps `/apps/new` a page rather than a slug
  // — the same precedence app-routes' RESERVED_APP_SLUGS makes `app_create` refuse. The
  // pane list is that module's, so a pane added there is mounted here with no second edit,
  // and `tools` is deliberately not in it: `/apps/<slug>/tools` falls to the 404 below,
  // because the landing pane has no alias (§13, "one URL per pane").
  //
  // The gate is `requireOwnerSession` with no options — §13's "`/apps/<slug>/*` is the
  // ordinary owner session", deliberately NOT /settings's recent-auth prefix rule.
  app.get("/apps/:slug", async (c) => appDetailPane(c, "tools"));
  app.get("/apps/:slug/:pane", async (c) => {
    const pane = c.req.param("pane") ?? "";
    if (!(APP_PANES as readonly string[]).includes(pane)) return noSuchPage();
    return appDetailPane(c, pane as AppPane);
  });

  /** One pane of one app, or the 404 an unknown, reserved or foreign slug shares. */
  async function appDetailPane(c: Context, pane: AppDetailPane): Promise<Response> {
    const ctx = await context(c.req.raw, await requireOwnerSession(c.req.raw));
    const props = await appDetailProps(ctx, c.req.param("slug") ?? "", pane);
    if (props === null) return noSuchPage();
    return render(AppDetailPage(props));
  }

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

  // §13's Token pane gets ONE route of its own, for the same reason `paths.appCreate` has
  // one: the reveal cannot survive a redirect and `dispatch` unconditionally redirects, so
  // the answer is a 200 rendering the pane with the plaintext in place (§15 — a key never
  // rides a URL). It still keeps the final-segment convention, so parity direction B
  // describes it like every other target. Mounted ahead of the generic pane dispatcher.
  app.post(
    `/apps/:slug/${TOKEN_ISSUE}`,
    mutation(async (c, session, form) => {
      const slug = c.req.param("slug") ?? "";
      const minted = await attempt(() =>
        ops[TOKEN_ISSUE].handler(session.user.userId, {
          ...queryFields(c.req.raw),
          ...formFields(form),
        }),
      );
      // A refusal has no plaintext to protect, so it goes back the way every other pane
      // mutation's does — to the pane that drew the form, carrying its own reason.
      const back = paths.appPane(slug, "token");
      if ("reason" in minted) return c.redirect(noticeUrl(back, TOKEN_ISSUE, minted), 303);
      const ctx = await context(c.req.raw, session);
      const props = await appDetailProps(ctx, slug, "token");
      if (props === null) return noSuchPage();
      return render(AppDetailPage({ ...props, reveal: tokenOf(minted.value) }));
    }),
  );

  // Every other mutation an `/apps/<slug>` pane renders, through the same generic dispatch
  // /apps' own mutations ride — and back to the pane that drew the form. Delete is the one
  // that cannot go back: the page it came from is the 404 §13 pins, so it lands on the list.
  app.post(
    "/apps/:slug/:op",
    dispatch((c) => {
      const pane = APP_OP_PANE[c.req.param("op") ?? ""];
      return pane === undefined ? paths.apps : paths.appPane(c.req.param("slug") ?? "", pane);
    }),
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

  // The list moved into Settings and the old URL is now a PERMANENT redirect to the pane
  // that holds it (§13/§19): 301 rather than 302, because the move is not temporary and a
  // bookmark should stop coming back here. No POST dispatcher of its own any more either —
  // Revoke moved with the pane, and `paths.connectionRevoke` posts under
  // `/settings/clients/`. Deliberately ungated: it renders nothing, so there is nothing to
  // gate, and the pane it points at is behind /settings's own prefix rule.
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
  // deps: sessionOf · checkCsrf
  return async (c) => {
    const session = await sessionOf(c, gate);
    const form = await c.req.formData();
    const refused = await checkCsrf(session.sessionId, form);
    if (refused !== null) return refused;
    return handle(c, session, form);
  };
}

/**
 * The session a handler runs under: the `/settings` prefix gate's, when that gate ran, and
 * otherwise this route's own. The gate is the only thing that ever stashes one, so "already
 * resolved" means exactly "under /settings" — and the fallback is what every route outside
 * that prefix takes, which is why this is not a cache with a lifetime but a read of what
 * the request already decided. A stashed session is always the STRICTER one (the gate asks
 * for §4's recent authentication unconditionally), so reusing it can never admit a session
 * a route's own `gate` would have refused.
 */
async function sessionOf(c: Context, gate?: { recent: boolean }): Promise<OwnerSession> {
  // deps: identity.requireOwnerSession
  return c.get("ownerSession") ?? requireOwnerSession(c.req.raw, gate);
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
 * makes "all of them" true of the family rather than of the seven that exist today.
 */
function credential(
  pane: string,
  endpoint: string,
  op: string,
  body: (form: FormData, req: Request) => Record<string, unknown> | Promise<Record<string, unknown>>,
  /** What this target answers with instead of the flash, when better-auth's own answer IS
   *  the point: it cannot ride a URL (§15) and `NOTICE_KEYS` cannot carry it
   *  (pages/model's `NOTICE_KEYS`). Returning null falls back to the flash — which is how
   *  a refusal with nothing to redraw AND a success that must not render both answer.
   *  That fallback is the WORST answer on a success arm and is deliberately kept anyway:
   *  a reveal that cannot read an ok payload (a better-auth field rename) tells the owner
   *  "done" with a secret already minted and, for regenerate, the previous set already
   *  invalidated. The two reveal rows are the whole guard against that — see the enable
   *  and regenerate rows in web-pages.test.ts. Throwing instead would trade a silent loss
   *  for a 500 on an operation better-auth has already committed, which is not better.
   *  The body is read exactly ONCE, on whichever arm this is, because a Response answers
   *  once: `refusalOf` moves ABOVE the redirect so the notice and this share that read.
   *  CONSTRAINT this function does not enforce: a target whose SUCCESS re-issues the
   *  session cookie must not reveal on that arm — the props below would be read with the
   *  cookie better-auth just deleted, and the CSRF token minted off a dead session id
   *  (`context`). /two-factor/verify-totp is exactly that target, which is why its
   *  success keeps the 303. */
  reveal?: (
    req: Request,
    session: OwnerSession,
    form: FormData,
    outcome:
      | { ok: true; answer: Record<string, unknown> }
      | { ok: false; code: string; message: string },
  ) => Promise<unknown>,
): (c: Context) => Promise<Response> {
  // deps: mutation · identity.callAuthResponse
  return mutation(async (c, session, form) => {
    const answered = await callAuthResponse(c.req.raw, endpoint, await body(form, c.req.raw));
    const succeeded = answered !== null && answered.ok;
    // Read once, on whichever arm. Parsing the success body costs the four call sites
    // without a reveal nothing: `redirectWith` takes only `Set-Cookie` headers off
    // `answered`, never its body.
    const outcome = succeeded
      ? { ok: true as const, answer: (await answered!.json().catch(() => ({}))) as Record<string, unknown> }
      : { ok: false as const, ...(await refusalOf(answered)) };
    const node = reveal ? await reveal(c.req.raw, session, form, outcome) : null;
    if (node) return render(node);
    return redirectWith(
      // `pane` and not `paths.settings`: §13 lands a notice on the pane that RENDERED the
      // form, and every one of them is drawn on a pane that is not the page root.
      noticeUrl(pane, op, outcome.ok ? { value: null } : { reason: outcome.message }),
      succeeded ? answered : null,
    );
  }, { recent: true });
}

/**
 * The one render behind all three /settings/two-factor reveals: the pane exactly as its
 * own GET would draw it, plus the overlay only a POST can know. `settingsProps` is
 * untouched — `enrollment: null` / `revealedBackupCodes: null` stay the loader's answer,
 * because a GET has neither — so the invariant `SettingsProps` documents (an overlay on
 * top of `twoFactor`, never an alternative to it) stays true by construction.
 *
 * Safe under a POST for two reasons that are both somebody else's: identity's
 * `callAuthResponse` builds a FRESH request out of the cookie alone, and `context` reads
 * only `new URL(req.url)`'s query, which a POST target has none of. It is also why the
 * reveal renders NO notice — there is no flash on a POST URL to read.
 */
async function settingsTwoFactorPage(
  req: Request,
  session: OwnerSession,
  overlay: Pick<SettingsProps, "enrollment" | "revealedBackupCodes">,
): Promise<unknown> {
  // deps: pages/model.settingsProps · context
  return SettingsPage({
    ...(await settingsProps(await context(req, session), req, "two-factor")),
    ...overlay,
  });
}

/**
 * The ten codes out of a better-auth answer that carries them: its wire format is a JSON
 * array, so there is nothing to decode — only `revealedCodesOf`'s judgement, which is what
 * makes a renamed or reshaped payload draw nothing instead of garbage.
 */
function answeredCodes(answer: Record<string, unknown>): string[] | null {
  // deps: pages/model.revealedCodesOf
  const codes = answer.backupCodes;
  return Array.isArray(codes) ? revealedCodesOf(codes.map(String)) : null;
}

/**
 * The same ten out of the enrolment form's hidden `codes` field, whose wire format is the
 * newline-joined set settings.tsx writes with `join("\n")` — those two are the only places
 * that know it. The `trim` is load-bearing, not tidiness: a browser normalizes a form
 * value's newlines to CRLF, so without it every code arrives with a trailing `\r`, fails
 * the shape check, and the refusal redraw silently loses all ten. The suite posts through
 * `URLSearchParams`, which does not normalize, so nothing would go red.
 */
function postedCodes(codes: string): string[] | null {
  // deps: pages/model.revealedCodesOf
  return revealedCodesOf(
    codes
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== ""),
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

/**
 * What a refused credential call is worth showing, and nothing else out of the body: the
 * one line — better-auth's own `message`, which names a field ("[body.password] Invalid
 * input") and never a submitted value (§15) — and its error `code`, which is the stable
 * name §13's Password pane maps onto a control. The rest of the body is no notice's
 * business, and the body is read exactly once because a Response can only answer once.
 */
async function refusalOf(response: Response | null): Promise<{ code: string; message: string }> {
  const body = (await response?.json().catch(() => null)) as
    | { code?: unknown; message?: unknown }
    | null;
  return {
    code: typeof body?.code === "string" ? body.code : "",
    message: typeof body?.message === "string" ? body.message : "The change was refused.",
  };
}

/** The op key **Update password** reports its outcome under, spelled once because the
 *  route writes it and `noticeOf` reads it back. */
const CHANGE_PASSWORD = "change_password";

/** The op **Issue new token** fronts, spelled once because its route mounts the name, keys
 *  the ops table with it and names it back in a refusal's notice. */
const TOKEN_ISSUE = "token_issue";

/**
 * Which `/apps/<slug>` pane owns each mutation its panes render, so the redirect-back lands
 * where the form was (§13). An op with no entry here has no pane to go back to — which is
 * exactly `app_delete`, whose page is the 404 §13 pins the moment it succeeds.
 */
const APP_OP_PANE: Record<string, AppPane> = {
  token_revoke: "token",
  app_archive: "danger",
  app_unarchive: "danger",
};

/**
 * §13's two mapped refusal codes, as the control each is drawn beside. A code that is not
 * here is not a hole: §13 sends "anything else" to the ordinary refusal notice, and a
 * table that guessed at better-auth's other codes would be inventing copy for them.
 */
const PASSWORD_REFUSAL_FIELD: Record<string, PasswordField> = {
  INVALID_PASSWORD: "currentPassword",
  PASSWORD_TOO_SHORT: "newPassword",
};

/**
 * §13's `N`: every session of this owner except the one posting, counted from
 * better-auth's own listing BEFORE the change. It cannot be counted after — a successful
 * `revokeOtherSessions` deletes every session including this one, so the cookie that
 * would ask is dead by then — and better-auth returns no count of its own.
 */
async function otherSessionCount(req: Request): Promise<number> {
  // deps: identity.callAuth
  const listed = await callAuth<unknown[]>(req, "/list-sessions");
  return Array.isArray(listed) ? Math.max(0, listed.length - 1) : 0;
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
 *
 * `back` is a FUNCTION where the pane that owns a form is known only per request — one
 * app's danger zone and another's are different URLs (§13's "mutations belong to a pane"),
 * and the slug is in the path.
 */
function dispatch(back: string | ((c: Context) => string)) {
  return mutation(async (c, session, form) => {
    const name = c.req.param("op") ?? "";
    const op = opNamed(name);
    if (op === undefined) return new Response("No such action\n", { status: 404, headers: TEXT });
    const input = { ...queryFields(c.req.raw), ...formFields(form) };
    const outcome = await attempt(() => op.handler(session.user.userId, input));
    return c.redirect(noticeUrl(typeof back === "string" ? back : back(c), name, outcome), 303);
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
 * neither is a credential (§15: admin's refusals name fields, never values). THE one
 * builder: every key it writes is spelled in `NOTICE_KEYS`, which the pages read the
 * same flash back through, so neither side can rename a key the other still expects.
 */
function noticeUrl(
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
  // confirm-mismatch check is the only one); `noticeOf` says the words for an absent
  // reason, so an empty one is left off rather than written as an empty message.
  if ("reason" in outcome && outcome.reason !== "") fields.set(NOTICE_KEYS.reason, outcome.reason);
  for (const [key, value] of Object.entries(extras)) {
    if (value !== undefined) fields.set(NOTICE_KEYS[key as "field" | "signedOut"], value);
  }
  return `${back}?${fields}`;
}

/** The flash the redirect above left, read back on the next render. */
function noticeOf(query: URLSearchParams): Notice | null {
  const done = query.get(NOTICE_KEYS.done);
  if (done !== null) {
    return done === CHANGE_PASSWORD
      ? passwordDone(query)
      : { tone: "success", message: `${humanize(done)} done.` };
  }
  const failed = query.get(NOTICE_KEYS.failed);
  if (failed === null) return null;
  return {
    tone: "danger",
    title: `${humanize(failed)} failed`,
    message: query.get(NOTICE_KEYS.reason) ?? "The change was refused.",
  };
}

/**
 * §13's Password-pane success copy — the one outcome this hub spells out rather than
 * naming its op, because three separate things are worth saying: what changed, what it
 * cost in sessions (only when the box was ticked), and what it did NOT touch. The last
 * sentence is true by construction, not by policy: app and agent keys are random secrets
 * in the hub's own table and nothing hashes the password into them (§4/§5).
 */
function passwordDone(query: URLSearchParams): Notice {
  const signedOut = query.get(NOTICE_KEYS.signedOut);
  return {
    tone: "success",
    title: "Password updated.",
    message: [
      signedOut === null ? null : `${signedOut} other session(s) were signed out — this one stays.`,
      "App and agent tokens keep working: they do not derive from the password.",
    ]
      .filter((line): line is string => line !== null)
      .join(" "),
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
    },
  });
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
