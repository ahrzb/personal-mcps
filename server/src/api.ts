// api.ts — the browser client's JSON surface, mounted at /api/hub by the composition root.
//
// WHAT THIS IS. §13's `/apps/*` and `/agents/*` are a browser SPA — `/audit` since decision
// 36, and every other page as decision 38 moves it — and this is the only way it reads or
// writes. Every route is cookie-authenticated exactly as the pages were — the
// same `resolveOwnerSession`, so a bearer is not a credential here either — and every write
// goes through the same three barriers a page POST went through (session, origin, CSRF),
// written once in `writer` below for `mutation`'s own reason: a fourth write cannot forget
// the order, because the order is how a write is spelled.
//
// WHAT THIS IS NOT. Not a second admin surface. The nine names `OPS_ALLOWED` lists are
// dispatched into `admin.ops` by name with the parsed body as input, so a client can do
// nothing a `pmcp` command cannot — the property §8's parity direction B pins, kept by
// construction rather than by review. The six typed routes exist only where a form composed
// a DELTA the op's own keys cannot express; each calls the same exported composer from
// pages/model that the deleted form route called, so "the SPA writes what the form wrote" is
// one function rather than two implementations. Two families sit beside them, each for a
// reason no op can carry: the push subscription (a browser's own, which no CLI can hold),
// and `/hub/settings/*` (decision 38) — credential management rides better-auth, §8's
// pinned exception, and the three ops-backed settings writes name one op each behind the
// recent-auth prefix the ordinary gate must not become a bypass of.
//
// WHAT IS NOT HERE. No page rendering (web.ts's `shell` serves the SPA document), no
// catalog collection (gateway's `ownerCatalog`), no validation of the values a write
// carries — `app_update` and `app_create` remain the authority for slugs, path grammar,
// identifier rules and collisions, and every refusal they make arrives here as a HubError
// and leaves as a 422 carrying its own field-scoped violations.
//
// deps: hono · identity (resolveOwnerSession, callAuth, callAuthResponse) · web (csrfOk,
//       noticeUrl) · admin.ops · gateway.ownerCatalog ·
//       catalog-view · registry (Registry, effectiveRoles, writeOnlyPaths) · tunnel.capabilities ·
//       upstream.beginConnect · pages/model (the composers, auditFilters/auditQueryOf,
//       approvalOf, settingsRead, enrollmentOf/revealedCodesOf) ·
//       wiring.approvalsFromEnv (subscribePush) · errors.HubError

import { env } from "cloudflare:workers";
import { Hono } from "hono";
import type { Context } from "hono";
import { ops } from "./admin";
import type { AppRow as OpsAppRow } from "./admin";
import type { PushSubscriptionJson } from "./approvals";
import { config as auditConfig } from "./audit";
import type { AuditRow, AuditSlimRow } from "./audit";
import { DEFAULT_APP_CAPABILITIES } from "./capabilities";
import { argumentRows, schemaLeaves } from "./catalog-view";
import type { ArgumentRow, SchemaLeaf } from "./catalog-view";
import { HubError } from "./errors";
import type { Violation } from "./errors";
import { ownerCatalog } from "./gateway";
import { aliasDiagnosticMessage } from "./hub-types";
import type { ListedItem } from "./gateway";
import { callAuth, callAuthResponse, resolveOwnerSession } from "./identity";
import type { OwnerSession } from "./identity";
import type { Connection } from "./oauth";
import { effectiveRoles, Registry, writeOnlyPaths } from "./registry";
import type { AppCapability, ListKind, RoleDeclaration, RoleFamily } from "./registry";
import { capabilities as tunnelCapabilities } from "./tunnel";
import { beginConnect } from "./upstream";
import { approvalsFromEnv } from "./wiring";
import { inlineMarkdown, plainText, renderMarkdown } from "./pages/markdown";
import { csrfOk, noticeUrl } from "./web";
import {
  approvalOf,
  auditFilters,
  auditQueryOf,
  composeOwnerRoles,
  composeRedaction,
  composeRoles,
  composeTypescriptAliases,
  enrollmentOf,
  eventRow,
  grantChoicesOf,
  noBodiesReason,
  paths,
  revealedCodesOf,
  settingsRead,
} from "./pages/model";
import type {
  AuditEventRow,
  DetailApproval,
  PasswordField,
  SettingsRead,
  TotpEnrollment,
} from "./pages/model";
import { AUDIT_EXPLORER_PAGE, AUDIT_EXPLORER_ROWS } from "./limits";

/* ------------------------------------------------------------------ *
 * The two audit reads' answers (§13's explorer, decision 36)
 * ------------------------------------------------------------------ */

/**
 * One row of the window read: `audit.AuditSlimRow` minus the namespace id, plus the
 * no-bodies sentence. A slim row "has bodies" when it carries an `argsHead` or reports a
 * result, which is what `noBodiesReason` reads it by.
 *
 * Exported so the browser client's own copy of this shape can be checked against it — the
 * wire shapes are deliberately copied rather than shared (contracts/README.md), and a copy
 * with no original to compare to is where the two drift.
 */
export type AuditWindowRow = Omit<AuditSlimRow, "ownerId"> & { noBodies?: AuditEventRow["noBodies"] };

/**
 * `GET /api/hub/audit/window` — one page of body-less rows, newest first, over a resolved
 * window.
 *
 * `since`/`until` are ECHOED rather than merely accepted: the client asks for a window it
 * may have left open at either end, and the server answers with the one it actually read, so
 * "now" is computed once. `total` counts the whole match regardless of the page or the
 * ceiling; `ceiling` is `AUDIT_EXPLORER_ROWS`, carried so the page's "showing the newest N
 * of M" notice holds no second literal of it. `retentionDays` is §15's window, which is
 * env-tunable and therefore data rather than copy.
 */
export type AuditWindow = {
  rows: AuditWindowRow[];
  total: number;
  since: number;
  until: number;
  retentionDays: number;
  ceiling: number;
};

/** `GET /api/hub/audit/:id` — the one full row, bodies and no-bodies sentence included. A
 *  wrapper object rather than the bare row, like every other answer on this surface: a
 *  field can be added beside it without changing what the client parses. */
export type AuditRecord = { row: AuditEventRow };

/* ------------------------------------------------------------------ *
 * The approvals routes (§13, decision 38)
 * ------------------------------------------------------------------ */

/**
 * `GET /api/hub/approvals/:id` — one approval of the caller's, as `/approvals/<id>` draws it.
 * `DetailApproval` is `approvals.ApprovalRow` (ISO-8601 timestamps, post-redaction `args`)
 * narrowed so a `rejected` or `used` row always carries its `decidedAt`. An id outside the
 * caller's namespace and one that never existed are the same 404 `{ reason: "No such
 * approval." }`.
 */
export type ApprovalDetailRead = { approval: DetailApproval };

/**
 * `POST /api/hub/approvals/push`'s body: the browser's own `PushSubscription.toJSON()` under
 * one key. Answers 204 with no body when stored, and 400 `{ reason }` when the subscription
 * is not this shape — a string, a missing key or a non-string field alike.
 */
export type PushSubscribeBody = { subscription: PushSubscriptionJson };

/* ------------------------------------------------------------------ *
 * The settings routes (§13, decision 38)
 * ------------------------------------------------------------------ */

/** `GET /api/hub/settings` — pages/model's `SettingsRead`, which composes the row types
 *  it is built from, re-exported here beside every other answer so the client's copy has
 *  one file to be checked against. */
export type { SettingsRead, TotpEnrollment };

/**
 * What a settings write answers where its form answered a 303 (routes §0.3). `next` is
 * byte for byte the Location that 303 named — built by the same `noticeUrl`, flash
 * included, never from input — and `reload` is true exactly when this answer forwards
 * better-auth's `Set-Cookie`: the session, and with it the CSRF token the document holds,
 * was replaced, so the client loads `next` as a document; otherwise it may route to it.
 */
export type Redirected = { next: string; reload: boolean };

/** Enable two-factor's reveal: the enrolment better-auth minted (`error` null) and its ten
 *  backup codes — in the body because neither may ride a URL (§15), and answered only when
 *  better-auth's answer yields both; anything less lands as `Redirected`. */
export type TotpEnabled = { enrollment: TotpEnrollment; backupCodes: string[] };

/** Regenerate backup codes' reveal: the fresh ten, shown this once. */
export type BackupCodesRevealed = { backupCodes: string[] };

/** Update password's body: the Password pane's three controls, and its **Sign out my other
 *  sessions** box as the boolean it is (§13's default-on is the client's to send). */
export type ChangePasswordBody = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  revokeOtherSessions: boolean;
};

/** The Execution pane's Save: the owner's own TEXT in both controls. A clean integer is
 *  turned into the op's number here; anything else reaches the op as typed, for it to
 *  refuse in its own words under the field it names (§23.3). */
export type ExecutionUpdateBody = { default_timeout_ms: string; max_timeout_ms: string };

/* ------------------------------------------------------------------ *
 * The drafts a typed route takes
 * ------------------------------------------------------------------ */

/**
 * §4's Roles editor, as the client submits it. Every field is exactly one input
 * `composeOwnerRoles` consumes — the shape is the composer's parameter list, spelled as
 * JSON, and nothing here is a second opinion about what a save means.
 *
 * `drawn` and `ticked` are separate because that is the distinction the composer turns on:
 * a literal in `drawn` but not `ticked` is REMOVED, a literal in neither KEEPS its stored
 * value (model.ts:5266-5280). `drawn` is the editor's own account of the coverage it
 * rendered — checked and unchecked alike — and is never reconstructed from the ticks and
 * never from a refetched catalog. That is what makes a filtered save safe: `?q=` hides
 * rows, and a hidden row is not an unticked one.
 */
export type RoleDraft = {
  /** The role being edited; "" for a new one. */
  was: string;
  /** Its (possibly renamed) name. */
  role: string;
  /** Delete `was` instead of writing it — the only delete trigger. */
  delete?: true;
  /** `<family>/<name>` item rows the editor RENDERED: its coverage. */
  drawn: string[];
  /** `<family>/<name>` whose checkbox came back ticked: the selection. */
  ticked: string[];
  /** `<family>/<pattern>` pattern rows the editor carried. */
  keeps: string[];
  /** `<family>/<pattern>` the owner removed. */
  drop?: string;
  /** A new pattern. */
  add?: string;
};

/** One direction of §5's Recording editor — args or results. */
export type RedactionDraft = {
  /** The render's own account of its coverage: one `(path, tools)` pair per path row. */
  drawn: [path: string, tools: string[]][];
  /** Paths whose ENABLED "all tools" box is ticked. A DISABLED checked control is not a
   *  submitted field on the form either, and including it would OR-cancel per-tool
   *  unticking (model.ts:5353-5356). */
  wholePath: string[];
  /** `<tool>.<path>` whose per-tool box is ticked. */
  perTool: string[];
};

/** §5's Recording pane, as the client submits it. */
export type RecordingDraft = {
  logBodies: boolean;
  args: RedactionDraft;
  results: RedactionDraft;
};

/** §23.6's alias editor, as the client submits it: the service control plus the rows,
 *  paired as the composer's indexed fields are paired. */
export type AliasDraft = {
  service: string;
  rows: { canonicalName: string; alias: string }[];
};

/** Either grant editor's submission: the whole set, replaced. `clear` is the Remove
 *  dialog — the same op with nothing to compose, since it replaces the pair's set. */
export type GrantDraft = {
  clear?: true;
  /** Entry → mode, exactly as the pane's per-row controls read: `allow`, `approval` or
   *  `none`. `none` contributes nothing, which is how the pane revokes. */
  entries: Record<string, "allow" | "approval" | "none">;
};

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

/**
 * The nine ops reachable through `POST /api/hub/ops/:op`, and the whole list of them.
 *
 * Each takes only scalar slug/id/kind arguments, so a JSON body IS its input and nothing
 * needs composing. The exclusions are as deliberate as the inclusions:
 *
 *  - `hub_settings_update`, `admin_token_issue`, `admin_token_revoke` and
 *    `connection_revoke` stay unreachable here because /settings is where they belong,
 *    behind the `{recent: true}` prefix — admitting them to the ordinary JSON gate would
 *    make it a freshness bypass. Since decision 38 two of them have a route of their own
 *    under that prefix (`/hub/settings/…`, one op each), and the admin-token pair none.
 *  - `agent_update` and `app_set_upstream_auth` are excluded because no surface invokes
 *    them; the CLI is their caller.
 *  - the four Save targets and `app_create` are excluded because they are not reachable as
 *    their own keys at all — they have typed routes below.
 *  - the read ops are excluded because a read is a GET, and the resources below are it.
 *
 * `token_issue` and `token_revoke` keep the ORDINARY gate, which is exactly their current
 * reachability from `/apps/<slug>/token` and `/agents/<slug>/credentials`: no tightening
 * and no loosening. Recent authentication is asked for only under `/hub/settings`, by
 * that prefix's own gate, never by this dispatcher.
 */
const OPS_ALLOWED: ReadonlySet<string> = new Set([
  "app_archive",
  "app_unarchive",
  "app_delete",
  "app_disconnect",
  "agent_create",
  "agent_delete",
  "token_issue",
  "token_revoke",
  "approval_decide",
]);

/** The four catalog families a client may ask for, and the `ListKind` each names. */
const FAMILY_KIND: Record<string, ListKind> = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
  resourceTemplates: "resourceTemplates",
};

/**
 * Which GRANT family each catalog family is matched under (§20.3). Resources and templates
 * are one keyspace — a template matched on its raw `uriTemplate` — so the two listings
 * answer to one family, which is why this is not `FAMILY_KIND` with the values reused.
 */
const SUBJECT_FAMILY: Record<string, RoleFamily> = {
  tools: "tools",
  prompts: "prompts",
  resources: "resources",
  resourceTemplates: "resources",
};

/**
 * `/api/hub` — the SPA's whole server surface. Mounted beside `/api/auth` and
 * `/api/whoami`, under the `api` segment the route table already reserves, so no
 * reservation moves.
 */
export function hubApiRoutes(): unknown {
  const app = new Hono();

  // `/api/hub/settings/*` is ONE rule, not twelve (routes §0.3, decision 38): every read and
  // write under it resolves the session with §4's RECENT authentication, written once as a
  // prefix — registered ahead of every route, since hono runs handlers in registration
  // order — so a route added there cannot be added ungated, and the ordinary gate below
  // never becomes a freshness bypass for /settings' ops. A stale session, a bearer-sourced
  // one and none are one answer: the 401 every reader gives. The session it resolved is
  // stashed for `sessionFor` to hand `reader` and `writer`, so it is resolved once.
  const settingsGate = async (c: Context, next: () => Promise<void>): Promise<Response | void> => {
    const session = await resolveOwnerSession(c.req.raw, { recent: true });
    if (session === null) return signIn();
    c.set("ownerSession", session);
    await next();
  };
  app.use("/hub/settings", settingsGate);
  app.use("/hub/settings/*", settingsGate);

  /* ------------------------------- reads -------------------------------- */

  app.get("/hub/apps", reader(async (session) => json(await ops.app_list.handler(session.user.userId, {}))));

  app.get(
    "/hub/apps/:slug",
    reader(async (session, c) => {
      const slug = c.req.param("slug") ?? "";
      // The one read that is not an ops handler, for the page's own reason: an app's
      // opaque id is addressing and no read op reports one (§3), and the id is what a
      // tunnel's declared capability set is keyed on. It doubles as this route's 404,
      // since `getApp` answers null for the builtin, the unknown and the foreign slug
      // alike — one answer, so a probe cannot tell those three apart.
      const app = await new Registry(env.DB).getApp(session.user.userId, slug);
      if (app === null) return noSuchApp();
      const detail = await read<{ app: OpsAppRow }>(session, "app_get", { slug });
      if (detail.app.kind === "builtin") return noSuchApp();
      return json({
        app: detail.app,
        kind: app.kind,
        // §23.6's owner-facing sentences, RENDERED here. `aliasDiagnosticMessage` is the
        // one author of that prose (hub-types owns it, and the provider's refresh reads the
        // same words), so handing the browser the raw diagnostic objects would invite a
        // second wording of one explanation.
        //
        // Each sentence carries its SUBJECT beside it — the family and canonical name it is
        // about — because the Catalog details card prints only the diagnostics belonging to
        // the selected member. Without them the client would have to pair this list against
        // the row's raw `typescriptDiagnostics` by index, which is a coupling neither side
        // could see.
        diagnostics: detail.app.typescriptDiagnostics.map((diagnostic) => ({
          family: diagnostic.family,
          canonicalName: diagnostic.canonicalName,
          message: aliasDiagnosticMessage(diagnostic),
        })),
      });
    }),
  );

  app.get(
    "/hub/apps/:slug/capabilities",
    reader(async (session, c) => {
      const slug = c.req.param("slug") ?? "";
      const app = await new Registry(env.DB).getApp(session.user.userId, slug);
      if (app === null) return noSuchApp();
      const detail = await read<{ app: OpsAppRow }>(session, "app_get", { slug });
      const row = detail.app;
      if (row.kind === "builtin") return noSuchApp();
      // §20.2/§20.5's advertised set, per kind — the same resolution gateway's
      // `capabilitiesFor` makes for the scoped handshake, because the dimming rule and
      // the handshake are two readings of one stored fact.
      const capabilities: readonly AppCapability[] =
        app.kind === "tunnel"
          ? await tunnelCapabilities(app.id)
          : ((row.kind === "proxy" ? row.capabilities : undefined) ?? DEFAULT_APP_CAPABILITIES);
      return json({
        capabilities,
        // §13 (2026-09-03): a tunneled app that has never connected has no catalog at all,
        // which is a different answer from an empty one and from an unread one.
        neverConnected: row.kind === "tunnel" && row.lastSeen === null,
      });
    }),
  );

  app.get(
    "/hub/apps/:slug/catalog/:family",
    reader(async (session, c) => {
      const slug = c.req.param("slug") ?? "";
      const family = c.req.param("family") ?? "";
      const kind = Object.prototype.hasOwnProperty.call(FAMILY_KIND, family)
        ? FAMILY_KIND[family]
        : undefined;
      if (kind === undefined) return refuse(404, "No such catalog family.");
      const app = await new Registry(env.DB).getApp(session.user.userId, slug);
      if (app === null) return noSuchApp();

      // §23.6's committed reservations, read on both sides of the listing. A tools read
      // IS the discovery boundary that allocates them, so a name may become established
      // by this very request — and the surfaces that print an app's TypeScript identity
      // (Overview, the Catalog rows) have to know to re-read the app row. The committed
      // RESERVATION map is what says so: `typescriptAliases` is the owner's input rather
      // than what was committed, and a non-empty `AliasPlan.activate` can reassert an
      // unchanged name (registry.ts:1752).
      const before = kind === "tools" ? await reservedNames(app.id) : null;
      const answered = await ownerCatalog(env, session.user.userId, slug, kind);
      if (!answered.ok) {
        // Unread, which is NOT empty: a needs-reconnect credential, an upstream that
        // never answered, and now the owner-listing deadline all leave here, and the
        // client draws the blank marker rather than a zero (gateway.ts:816-825).
        return refuse(503, answered.failure.message, { unread: true });
      }
      const after = before === null ? null : await reservedNames(app.id);
      return json({
        family,
        items: answered.items,
        derived: answered.items.map((item) => derivationOf(item, SUBJECT_FAMILY[family])),
        ...(before === null || after === null ? {} : { namesChanged: before !== after }),
      });
    }),
  );

  app.get(
    "/hub/apps/:slug/roles",
    reader(async (session, c) => {
      const slug = c.req.param("slug") ?? "";
      const app = await new Registry(env.DB).getApp(session.user.userId, slug);
      if (app === null) return noSuchApp();
      const detail = await read<{ app: OpsAppRow }>(session, "app_get", { slug });
      const row = detail.app;
      if (row.kind === "builtin") return noSuchApp();
      // §1's merge rule, read once: the owner's roles, then the app's declaration on top.
      // Three fields rather than one, because the editor needs all three — which name is
      // the owner's to rename, which is the app's and therefore uneditable, and which map
      // the door actually resolves against.
      const ownerRoles: RoleDeclaration = row.kind === "tunnel" ? row.ownerRoles : row.roles;
      const declaredRoles: RoleDeclaration = row.kind === "tunnel" ? row.roles : {};
      return json({
        ownerRoles,
        declaredRoles,
        effective: effectiveRoles({ declaredRoles, ownerRoles }),
      });
    }),
  );

  app.get(
    "/hub/agents",
    reader(async (session) => json(await ops.agent_list.handler(session.user.userId, {}))),
  );

  app.get(
    "/hub/agents/:slug",
    reader(async (session, c) => {
      const slug = c.req.param("slug") ?? "";
      const listed = await read<{ agents: ListedAgent[] }>(session, "agent_list");
      const agent = listed.agents.find((each) => each.slug === slug);
      // The agent listing is the namespace's whole agent set, so a slug missing from it
      // is unknown or another owner's — indistinguishable, like the app 404 above.
      if (agent === undefined) return refuse(404, "No such agent.");
      const connections = await read<{ connections: Connection[] }>(session, "connection_list");
      return json({ agent, agents: listed.agents, connections: connections.connections });
    }),
  );

  // `token_list` declares no fields (admin.ts:1484), so there is no `?kind=` to forward
  // and no filtering to do here: the whole namespace's credentials come back and the
  // client narrows to the app or agent whose pane is drawn.
  app.get("/hub/tokens", reader(async (session) => json(await ops.token_list.handler(session.user.userId, {}))));

  app.get(
    "/hub/audit",
    reader(async (session, c) => {
      const url = new URL(c.req.url);
      const filters = auditFilters({ now: new Date().toISOString(), query: url.searchParams });
      const page = await read<unknown>(session, "audit_query", {
        ...auditQueryOf(filters),
        limit: filters.limit,
        offset: filters.offset,
      });
      return json({ filters, page });
    }),
  );

  // Registered AHEAD of `/hub/audit/:id`, or the literal segment is read as an id: hono
  // matches in declaration order, and `window` is not a number but `:id` does not know that.
  app.get(
    "/hub/audit/window",
    reader(async (session, c) => {
      const asked = new URL(c.req.url).searchParams;
      const { retentionDays } = auditConfig();
      // The server resolves the window and echoes it, so the client never computes "now"
      // twice — and an absent or unusable bound means the whole retention window rather
      // than a guess either side could make differently.
      const until = wholeNumber(asked.get("until")) ?? Date.now();
      const since = wholeNumber(asked.get("since")) ?? until - retentionDays * DAY_MS;
      const offset = wholeNumber(asked.get("offset")) ?? 0;
      const text = asked.get("text") ?? "";
      const page = await read<{ rows: AuditSlimRow[]; total: number }>(session, "audit_query", {
        since,
        until,
        ...(text.trim() === "" ? {} : { text }),
        bodies: false,
        // Clamped to what is LEFT under the ceiling, not to the page size: an offset the
        // client did not align (a deep link, a retried page) would otherwise answer rows
        // beyond the very ceiling this response echoes. At or past it the remainder is 0,
        // which is the empty page — the signal the client walks pages until it gets, and it
        // still costs the COUNT that `total` is.
        limit: Math.max(0, Math.min(AUDIT_EXPLORER_PAGE, AUDIT_EXPLORER_ROWS - offset)),
        offset,
      });
      const logBodies = await logBodiesOf(session);
      return json({
        rows: page.rows.map((row) => windowRow(row, logBodies)),
        total: page.total,
        since,
        until,
        retentionDays,
        ceiling: AUDIT_EXPLORER_ROWS,
      } satisfies AuditWindow);
    }),
  );

  app.get(
    "/hub/audit/:id",
    reader(async (session, c) => {
      const id = wholeNumber(c.req.param("id") ?? null);
      // A non-numeric segment is not an id at all, and answers exactly as an id in another
      // namespace does — one 404, so a probe learns nothing about either (§8).
      if (id === null) return noSuchRecord();
      const page = await read<{ rows: AuditRow[] }>(session, "audit_query", { id, limit: 1 });
      const row = page.rows[0];
      if (row === undefined) return noSuchRecord();
      return json({ row: eventRow(row, await logBodiesOf(session)) } satisfies AuditRecord);
    }),
  );

  // Two resources rather than one, because `Approvals.list` filters BEFORE it limits
  // (approvals.ts:446-447): counting pending rows inside a limited history response
  // undercounts, and the nav badge is exactly that count.
  app.get(
    "/hub/approvals",
    reader(async (session, c) => {
      const url = new URL(c.req.url);
      const status = url.searchParams.get("status");
      const limit = url.searchParams.get("limit");
      const input =
        status !== null ? { status } : limit !== null ? { limit: Number(limit) } : {};
      return json(await ops.approval_list.handler(session.user.userId, input));
    }),
  );

  // The detail page's read: the lookup the shell's document 404 makes (web.ts's
  // `approvalExists`), so a URL that answers a shell always has a row to show.
  app.get(
    "/hub/approvals/:id",
    reader(async (session, c) => {
      const approval = await approvalOf(session.user.userId, c.req.param("id") ?? "");
      if (approval === null) return refuse(404, "No such approval.");
      return json({ approval } satisfies ApprovalDetailRead);
    }),
  );

  /* ------------------------------- writes ------------------------------- */

  app.post(
    "/hub/ops/:op",
    writer(async (session, c, body) => {
      const name = c.req.param("op") ?? "";
      // A name outside the allowlist answers exactly as a name outside `ops` does, so a
      // probe cannot learn which ops exist but are withheld from this surface.
      const op = OPS_ALLOWED.has(name) ? opNamed(name) : undefined;
      if (op === undefined) return refuse(404, "No such action");
      // Straight through: `parseInput` refuses an undeclared field and type-checks each
      // declared one, and a JSON body can carry the real booleans and integers `coerce`
      // demands — which is the one thing a form's all-strings input never could.
      return outcome(await attempt(() => op.handler(session.user.userId, body)));
    }),
  );

  // The browser's own PushSubscription, handed to the module that owns Web Push. Not an op
  // and never a tool: what a browser subscribes is a property of THAT browser, which no CLI
  // or agent can hold or replay (§13) — so it is a typed route beside the allowlist, not a
  // name on it.
  app.post(
    "/hub/approvals/push",
    writer(async (session, _c, body) => {
      const subscription = subscriptionOf(body.subscription);
      if (subscription === null) {
        return refuse(400, "subscription must be a PushSubscription: an endpoint and keys.p256dh and keys.auth strings.");
      }
      // No push transport wired: subscribing sends nothing (wiring.approvalsFromEnv).
      await approvalsFromEnv().subscribePush(session.user.userId, subscription);
      return new Response(null, { status: 204 });
    }),
  );

  /* ------------------------------ settings ------------------------------ */
  //
  // §13's /settings panes (decision 38): ONE read for the rail and every pane, and each
  // form target `/settings/X` as `POST /api/hub/settings/X`, JSON in — all behind the
  // recent-auth prefix above. The eight credential writes ride better-auth through
  // identity's one door and front no op (§8's pinned exception); the three below them each
  // name ONE op, so no generic dispatcher survives under the prefix. Each write lands where
  // its form's 303 did, on the pane that drew the control (§13's "mutations belong to a
  // pane"), and says so in `next`.

  app.get(
    "/hub/settings",
    reader(async (session, c) =>
      json(
        (await settingsRead({ ownerId: session.user.userId, sessionId: session.sessionId }, c.req.raw)) satisfies SettingsRead,
      ),
    ),
  );

  // Enable two-factor. better-auth mints the secret AND the ten codes in this one answer
  // and never repeats either — a second enable rotates the secret, and nothing can show the
  // codes again (§4) — so the answer IS the reveal, in the body because neither may ride a
  // URL (§15). It sets no cookie. An answer yielding less (a refusal, a renamed field) lands
  // the flash on the pane instead.
  app.post(
    "/hub/settings/two-factor/enable",
    writer(async (_session, c, body) => {
      const password = stringOf(body, "password");
      if (password === null) return refuse(400, "password must be a string.");
      const called = await credentialCall(c.req.raw, "/two-factor/enable", { password });
      if (called.ok) {
        const enrollment = enrollmentOf(String(called.answer.totpURI ?? ""), null);
        const backupCodes = answeredCodes(called.answer);
        if (enrollment !== null && backupCodes !== null) {
          return json({ enrollment, backupCodes } satisfies TotpEnabled);
        }
      }
      return landed(paths.settingsTwoFactor, "two_factor_enable", called);
    }),
  );

  // The enrolment's verify: the code typed under the QR. A refused code is the client's to
  // redraw beside the enrolment it already holds — which is why nothing of the enrolment is
  // posted back here to be echoed (§15) — so the refusal is better-auth's own words at 422
  // rather than a flash. A verified one REPLACES the session (better-auth deletes the one this
  // ran under and mints another), so its forwarded Set-Cookie makes the answer say reload.
  app.post(
    "/hub/settings/two-factor/verify-totp",
    writer(async (_session, c, body) => {
      const code = stringOf(body, "code");
      if (code === null) return refuse(400, "code must be a string.");
      const called = await credentialCall(c.req.raw, "/two-factor/verify-totp", { code });
      if (!called.ok) return refuse(422, called.message);
      return landed(paths.settingsTwoFactor, "two_factor_enable", called);
    }),
  );

  app.post(
    "/hub/settings/two-factor/disable",
    writer(async (_session, c, body) => {
      const password = stringOf(body, "password");
      if (password === null) return refuse(400, "password must be a string.");
      return landed(
        paths.settingsTwoFactor,
        "two_factor_disable",
        await credentialCall(c.req.raw, "/two-factor/disable", { password }),
      );
    }),
  );

  // Regenerate backup codes: Enable's reveal with the smaller body, for the same reason — a
  // fresh set is shown exactly once and a URL is not where it can be. A wrong password has
  // no set to show and lands the flash.
  app.post(
    "/hub/settings/two-factor/generate-backup-codes",
    writer(async (_session, c, body) => {
      const password = stringOf(body, "password");
      if (password === null) return refuse(400, "password must be a string.");
      const called = await credentialCall(c.req.raw, "/two-factor/generate-backup-codes", { password });
      const backupCodes = called.ok ? answeredCodes(called.answer) : null;
      if (backupCodes !== null) return json({ backupCodes } satisfies BackupCodesRevealed);
      return landed(paths.settingsTwoFactor, "backup_codes_generate", called);
    }),
  );

  app.post(
    "/hub/settings/passkey/delete-passkey",
    writer(async (_session, c, body) => {
      const id = stringOf(body, "id");
      if (id === null) return refuse(400, "id must be a string.");
      return landed(paths.settingsPasskeys, "passkey_remove", await credentialCall(c.req.raw, "/passkey/delete-passkey", { id }));
    }),
  );

  // The one credential write that is more than a rename: the pane knows a session by the
  // id the read lists, and better-auth's revoke takes its TOKEN, which the read never
  // carries (§15) — so the listing is read again here to pair them, and the token dies here.
  app.post(
    "/hub/settings/revoke-session",
    writer(async (_session, c, body) => {
      const id = stringOf(body, "id");
      if (id === null) return refuse(400, "id must be a string.");
      const token = (await sessionTokenFor(c.req.raw, id)) ?? "";
      return landed(paths.settingsSessions, "session_revoke", await credentialCall(c.req.raw, "/revoke-session", { token }));
    }),
  );

  // §13's Revoke all others: keeps the session asking and deletes every other — the
  // opposite contract from the Password pane's box, deliberately not unified with it.
  app.post(
    "/hub/settings/revoke-other-sessions",
    writer(async (_session, c) =>
      landed(paths.settingsSessions, "revoke_other_sessions", await credentialCall(c.req.raw, "/revoke-other-sessions", {})),
    ),
  );

  // §13's Update password. Three of its sentences are about the ANSWER rather than the
  // call: the hub pre-checks new ≠ confirm (better-auth's body has no confirm field, so
  // nobody else can), better-auth's error CODE picks the control a refusal is drawn beside,
  // and `N` is counted before the call — after a successful revoke there is no listing left
  // to count and no cookie left to ask with.
  app.post(
    "/hub/settings/change-password",
    writer(async (_session, c, body) => {
      const draft = passwordDraftOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      const pane = paths.settingsPane("password");
      // The ONE check the hub makes itself, BEFORE the call: a mistyped confirmation must
      // not reach better-auth, which would happily set the password the owner did not mean.
      // No `reason`: the hub's own refusal has no upstream sentence (noticeUrl says why).
      if (draft.newPassword !== draft.confirmPassword) {
        return redirected(noticeUrl(pane, CHANGE_PASSWORD, { reason: "" }, { field: "confirmPassword" }), null);
      }
      const others = draft.revokeOtherSessions ? await otherSessionCount(c.req.raw) : null;
      const called = await credentialCall(c.req.raw, "/change-password", {
        currentPassword: draft.currentPassword,
        newPassword: draft.newPassword,
        revokeOtherSessions: draft.revokeOtherSessions,
      });
      if (!called.ok) {
        // Every refusal carries the ordinary notice — better-auth's own words; what a
        // MAPPED code adds is the control §13 draws its sentence beside.
        const named = PASSWORD_REFUSAL_FIELD[called.code];
        return redirected(
          noticeUrl(pane, CHANGE_PASSWORD, { reason: called.message }, named === undefined ? {} : { field: named }),
          null,
        );
      }
      // With the box ticked better-auth replaces this session too, and its Set-Cookie rides
      // on — dropping it would sign the owner out (§13) — so the answer says reload.
      return redirected(
        noticeUrl(pane, CHANGE_PASSWORD, { value: null }, others === null ? {} : { signedOut: String(others) }),
        called.response,
      );
    }),
  );

  // The two ops-backed panes' one write each (§13's Tokens and Connected clients): the body
  // IS the op's input, straight through with no second validator — `parseInput` refuses a
  // key the op does not declare — and a refusal is the 422 every op refusal on this surface
  // is. `token_revoke` keeps this pane's recent gate although the ordinary allowlist admits
  // it too (§13: a page's gate is every pane's gate).
  app.post("/hub/settings/tokens/token_revoke", opWrite(paths.settingsTokens, "token_revoke"));
  app.post("/hub/settings/clients/connection_revoke", opWrite(paths.settingsClients, "connection_revoke"));

  // §23.3's Execution Save. The two controls are the owner's own text; a clean integer
  // becomes the op's number and anything else reaches the op as typed, for its own `count`
  // check to refuse under the field it names — a second validator here would be a second
  // set of words for the same mistake. The refusal carries the op's violations so the
  // client can draw each sentence under its control, keeping what the owner typed.
  app.post(
    "/hub/settings/execution/hub_settings_update",
    writer(async (session, _c, body) => {
      const answered = await attempt(() =>
        ops.hub_settings_update.handler(session.user.userId, {
          default_timeout_ms: executionField(body.default_timeout_ms),
          max_timeout_ms: executionField(body.max_timeout_ms),
        }),
      );
      return "value" in answered
        ? redirected(noticeUrl(paths.settingsExecution, "hub_settings_update", answered), null)
        : outcome(answered);
    }),
  );

  /**
   * §8's create, whole: the op, then the arm its answer requires. One route rather than a
   * create plus a follow-up call, because two of the three arms carry something the client
   * cannot ask for twice — a plaintext key shown exactly once (§15), and an authorize URL
   * bound to a single-use state row.
   */
  app.post(
    "/hub/apps",
    writer(async (session, c, body) => {
      const draft = appDraftOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      // The display name, not the slug: §13:218-223's connecting screen reads
      // "Connecting to <name>…", and a blank Name defaults to the slug at the op, so the
      // fallback is applied here too rather than left for the client to guess.
      const name = draft.name.trim() === "" ? draft.slug : draft.name;
      const aliases = composeTypescriptAliases(draft.aliasFields);
      if ("error" in aliases) return refuse(422, aliases.error);
      const created = await attempt(() =>
        ops.app_create.handler(session.user.userId, {
          slug: draft.slug,
          kind: draft.kind,
          // A blank Name is not SENT, so the op defaults it to the slug (§8/§13).
          ...(draft.name.trim() === "" ? {} : { name: draft.name }),
          // Proxy-only fields are rejected on a tunneled create (§8), so they are sent
          // only where they mean something. `authMode` is the control's name and `auth`
          // is the op's — the one place the two spellings meet.
          ...(draft.kind === "proxy" ? { endpoint: draft.endpoint, auth: draft.authMode } : {}),
          // An untouched alias section composes to `{}`, which says exactly what an absent
          // key says to a create — so it is not sent at all.
          ...(Object.keys(aliases.aliases).length === 0 ? {} : { typescript_aliases: aliases.aliases }),
        }),
      );
      if ("reason" in created) return outcome(created);

      if (draft.kind === "proxy" && draft.authMode === "oauth") {
        const app = await new Registry(env.DB).getApp(session.user.userId, draft.slug);
        const started =
          app === null
            ? { reason: "No such app." }
            : await attempt(() => beginConnect(app, { id: session.sessionId }));
        // A refused begin leaves the CREATE standing: the app exists, and the client
        // lands on its Overview with the reason, exactly as the form route did.
        return "reason" in started
          ? json({ slug: draft.slug, name, connectError: started.reason })
          : json({ slug: draft.slug, name, connect: { authorizeUrl: String(started.value) } });
      }

      // A proxied app has nothing that connects, so it has no token to reveal (§6).
      const minted =
        draft.kind === "tunnel"
          ? await attempt(() => ops.token_issue.handler(session.user.userId, { kind: "app", slug: draft.slug }))
          : null;
      return json({
        slug: draft.slug,
        name,
        ...(draft.kind === "tunnel"
          ? { token: minted !== null && "value" in minted ? tokenOf(minted.value) : null }
          : {}),
      });
    }),
  );

  /**
   * §4's Save. The ONE read here is `app_get`, for the stored map the delta merges into:
   * the client never sends a whole map, so that read is what keeps a concurrent change to
   * an UNDRAWN entry from being overwritten. A catalog read would be a second answer taken
   * after the one the editor was drawn against, and is deliberately absent.
   */
  app.put(
    "/hub/apps/:slug/roles",
    writer(async (session, c, body) => {
      const slug = c.req.param("slug") ?? "";
      const draft = roleDraftOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      const current = await attempt(() => ops.app_get.handler(session.user.userId, { slug }));
      if ("reason" in current) return outcome(current);
      // `app_get`'s result shape is admin's own and `handler` erases it to `unknown`;
      // asserted rather than re-validated because the value never left this isolate.
      const detail = current.value as { app: OpsAppRow };
      const row = detail.app;
      if (row.kind === "builtin") return noSuchApp();
      // Which stored map is being edited follows the KIND, and the page never mixes them:
      // a tunneled app's owner roles live beside the app's declaration, a proxied app's
      // roles are already all the owner's (§1).
      const tunnelled = row.kind === "tunnel";
      const stored = tunnelled ? row.ownerRoles : row.roles;
      const declared = tunnelled ? row.roles : {};
      const composed = composeOwnerRoles(
        stored,
        declared,
        roleFieldsOf(draft.draft),
        draft.draft.keeps,
        draft.draft.drawn,
      );
      // A name the op is never GIVEN is a name the op cannot refuse: an empty one would
      // simply leave the map without a key and answer 200 to a save that saved nothing.
      if (composed.refusal !== null) return refuse(422, composed.refusal);
      const saved = await attempt(() =>
        ops.app_update.handler(session.user.userId, {
          slug,
          ...(tunnelled ? { owner_roles: composed.roles } : { roles: composed.roles }),
        }),
      );
      if ("reason" in saved) return outcome(saved);
      return json({ role: composed.role, was: composed.was, deleted: composed.deleted });
    }),
  );

  /** §5's Save. Reads `app_get` for the same reason the Roles save does, and for no other:
   *  `composeRedaction` merges a delta into a stored map. */
  app.put(
    "/hub/apps/:slug/recording",
    writer(async (session, c, body) => {
      const slug = c.req.param("slug") ?? "";
      const draft = recordingDraftOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      const current = await attempt(() => ops.app_get.handler(session.user.userId, { slug }));
      if ("reason" in current) return outcome(current);
      // Asserted for the reason the Roles save's read is.
      const detail = current.value as { app: OpsAppRow };
      const row = detail.app;
      if (row.kind === "builtin") return noSuchApp();
      return outcome(
        await attempt(() =>
          ops.app_update.handler(session.user.userId, {
            slug,
            log_bodies: draft.draft.logBodies,
            redact: composeRedaction(row.redact, "args", redactFieldsOf(draft.draft.args, "args"), draft.draft.args.drawn),
            redact_results: composeRedaction(
              row.redactResults,
              "results",
              redactFieldsOf(draft.draft.results, "results"),
              draft.draft.results.drawn,
            ),
          }),
        ),
      );
    }),
  );

  /** §23.6's Save. No stored read at all: `composeTypescriptAliases` composes from its own
   *  fields, the object is sent WHOLE, and an extra read would add a failure point with
   *  nothing to merge. */
  app.put(
    "/hub/apps/:slug/aliases",
    writer(async (session, c, body) => {
      const slug = c.req.param("slug") ?? "";
      const draft = aliasFieldsOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      const composed = composeTypescriptAliases(draft.fields);
      if ("error" in composed) return refuse(422, composed.error);
      return outcome(
        await attempt(() =>
          ops.app_update.handler(session.user.userId, { slug, typescript_aliases: composed.aliases }),
        ),
      );
    }),
  );

  /** §6's Save from the app's Agents pane: the agent rides the body, the app is the URL.
   *  No stored read — the submitted set REPLACES the pair's whole set. */
  app.put(
    "/hub/apps/:slug/grants",
    writer(async (session, c, body) => {
      const slug = c.req.param("slug") ?? "";
      const agent = stringOf(body, "agent");
      if (agent === null) return refuse(400, "agent must be a string.");
      const draft = grantDraftOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      return outcome(
        await attempt(() =>
          ops.grant_set.handler(session.user.userId, { agent, app: slug, roles: rolesOf(draft.draft) }),
        ),
      );
    }),
  );

  /** The SAME `grant_set`, composed by the same function, from the agent's own pane —
   *  which is what §6's "composes exactly what the agent page's does" means. */
  app.put(
    "/hub/agents/:slug/apps/:app/grants",
    writer(async (session, c, body) => {
      const agent = c.req.param("slug") ?? "";
      const target = c.req.param("app") ?? "";
      const draft = grantDraftOf(body);
      if ("reason" in draft) return refuse(400, draft.reason);
      return outcome(
        await attempt(() =>
          ops.grant_set.handler(session.user.userId, { agent, app: target, roles: rolesOf(draft.draft) }),
        ),
      );
    }),
  );

  return app;
}

/* ------------------------------------------------------------------ *
 * The two gates
 * ------------------------------------------------------------------ */

/**
 * A read: the session, and nothing else. A read mutates nothing, which is the same reason
 * `mutation` excludes GETs (web.ts:1206-1207) — there is no state for a cross-site GET to
 * change, and the cookie is SameSite regardless.
 */
function reader(
  handle: (session: OwnerSession, c: Context) => Promise<Response>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const session = await sessionFor(c);
    if (session === null) return signIn();
    return handle(session, c);
  };
}

/**
 * A write, in the order that order is written ONCE: session, origin, CSRF, body, handler.
 * `mutation`'s own comment names this seam as where a cross-cutting origin rule belongs,
 * and here it is one — the page gate leans on better-auth's SameSite cookie plus the form
 * field, and this surface adds the header.
 *
 * `X-Pmcp-Csrf` is itself a barrier and not merely a re-spelling of the form field: a
 * custom header cannot be set cross-origin without a preflight the hub never answers, so a
 * cross-site page cannot reach a handler here even before the token is compared.
 */
function writer(
  handle: (session: OwnerSession, c: Context, body: Record<string, unknown>) => Promise<Response>,
): (c: Context) => Promise<Response> {
  return async (c) => {
    const session = await sessionFor(c);
    if (session === null) return signIn();
    if (crossOrigin(c.req.raw)) return refuse(403, "Forbidden");
    if (!(await csrfOk(session.sessionId, c.req.header("X-Pmcp-Csrf") ?? null))) {
      return refuse(403, "Forbidden");
    }
    const body = await c.req.raw
      .json()
      .then((parsed) => (isRecord(parsed) ? parsed : null))
      .catch(() => null);
    if (body === null) return refuse(400, "Body must be a JSON object.");
    return handle(session, c, body);
  };
}

/**
 * The session a route runs under: the settings prefix gate's, where that gate ran — it is
 * the only thing that stashes one, and its session is the STRICTER (recent) one, so reusing
 * it can never admit a session the ordinary gate would refuse — and otherwise this
 * request's own ordinary one, or null for none.
 */
async function sessionFor(c: Context): Promise<OwnerSession | null> {
  return c.get("ownerSession") ?? resolveOwnerSession(c.req.raw);
}

/**
 * The origin rule, the same if-present-must-match shape the /login routes and the consumer
 * surface stand on: a non-browser client sends no Origin and passes, a same-site fetch
 * sends the hub's own, and the cross-site post this refuses is the one that would otherwise
 * ride a browser's ambient cookies.
 */
function crossOrigin(req: Request): boolean {
  const origin = req.headers.get("Origin");
  return origin !== null && origin !== env.PUBLIC_ORIGIN;
}

/* ------------------------------------------------------------------ *
 * Answers
 * ------------------------------------------------------------------ */

/** Every successful answer. `no-store` like every other session-derived response: a
 *  browser that keeps a copy shows a stale or someone else's namespace. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** Every refusal, as one shape: `reason` and whatever the status adds. A refusal names
 *  fields and never submitted values (§15). */
function refuse(status: number, reason: string, extra: Record<string, unknown> = {}): Response {
  return json({ reason, ...extra }, status);
}

/** The absent-session answer. 401 rather than the page gate's 302: a `fetch` cannot follow
 *  a redirect into the address bar, so the client is told to go to /login and does. */
function signIn(): Response {
  return refuse(401, "Sign in again.");
}

/** The 404 the builtin `pmcp`, an unknown slug and a foreign slug share — one answer, so a
 *  probe learns nothing about another namespace (§13's document 404 as JSON). */
function noSuchApp(): Response {
  return refuse(404, "No such app.");
}

/** The record read's own version of the same rule: an id that never existed, one another
 *  namespace holds, and a segment that is not a number are one answer (§8). */
function noSuchRecord(): Response {
  return refuse(404, "No such audit record.");
}

/** A whole non-negative number off a query parameter or a path segment, or null for
 *  everything else — `?offset=drop table` is not an offset and `/audit/window` is not an id. */
function wholeNumber(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Retention is configured in DAYS and every timestamp in the system is epoch ms. */
const DAY_MS = 24 * 60 * 60_000;

/**
 * Why a bodiless call row is bodiless: each app's `log_bodies` as it stands NOW (§15), read
 * through `app_list` like the server-rendered page read it. Archived apps and the virtual
 * `pmcp` builtin are in it; an app that is GONE is simply absent, which is the `unrecorded`
 * case rather than a missing answer.
 */
async function logBodiesOf(session: OwnerSession): Promise<Map<string, boolean>> {
  const listed = await read<{ apps: OpsAppRow[] }>(session, "app_list");
  return new Map(listed.apps.map((app) => [app.slug, app.logBodies]));
}

/** One slim row as the window read answers it: the namespace id dropped (every row is the
 *  viewer's own) and the no-bodies sentence computed here, once, for the same reason the
 *  record read has `eventRow` do it — two readers of one ledger owe one explanation. */
function windowRow(row: AuditSlimRow, logBodies: Map<string, boolean>): AuditWindowRow {
  const { ownerId: _ownerId, ...rest } = row;
  const why = noBodiesReason(row, logBodies);
  return { ...rest, ...(why === undefined ? {} : { noBodies: why }) };
}

/** One ops answer as this surface renders it: the value, or §8's field-scoped refusal. */
function outcome(attempted: Attempted): Response {
  return "value" in attempted
    ? json({ value: attempted.value })
    : json(
        {
          reason: attempted.reason,
          ...(attempted.violations === undefined ? {} : { violations: attempted.violations }),
        },
        422,
      );
}

/**
 * Runs one ops handler and separates the two answers a client renders differently: a value,
 * or an owner-fixable refusal. Only HubError is caught — a bug inside a handler must reach
 * the composition root as the 500 it is, never a message telling the owner they asked
 * wrongly (admin.ts and web.ts draw the same line for the same reason).
 */
async function attempt(work: () => Promise<unknown>): Promise<Attempted> {
  try {
    return { value: await work() };
  } catch (err) {
    if (!(err instanceof HubError)) throw err;
    return err.violations === undefined
      ? { reason: err.message }
      : { reason: err.message, violations: [...err.violations] };
  }
}

type Attempted = { value: unknown } | { reason: string; violations?: Violation[] };

/** An op by name — `hasOwnProperty` so a request naming `toString` names no tool. */
function opNamed(name: string): (typeof ops)[string] | undefined {
  return Object.prototype.hasOwnProperty.call(ops, name) ? ops[name] : undefined;
}

/** One ops read, by name. A name that is not in the table is a bug in this file, never a
 *  caller's input, so it throws rather than refusing. */
async function read<T>(session: OwnerSession, name: string, input: Record<string, unknown> = {}): Promise<T> {
  const op = opNamed(name);
  if (op === undefined) throw new Error(`api: no such admin op "${name}"`);
  return (await op.handler(session.user.userId, input)) as T;
}

/* ------------------------------------------------------------------ *
 * The settings writes' shared pieces (decision 38)
 * ------------------------------------------------------------------ */

/**
 * One `{ next, reload }` answer, carrying better-auth's own `Set-Cookie` headers on from
 * `from`. The forwarding is why a credential write holds better-auth's Response rather than
 * `callAuth`'s body: a replaced session whose cookie is dropped has signed the owner out.
 * `reload` is DERIVED from what was forwarded, so the flag and the headers cannot disagree.
 */
function redirected(next: string, from: Response | null): Response {
  const cookies = from?.headers.getSetCookie() ?? [];
  const answer = json({ next, reload: cookies.length > 0 } satisfies Redirected);
  for (const cookie of cookies) answer.headers.append("Set-Cookie", cookie);
  return answer;
}

/** One credential write's better-auth answer, read ONCE because a Response answers once:
 *  a success's body beside the Response `redirected` forwards cookies from, or a refusal's
 *  own words and code (`refusalOf`). */
type CredentialCall =
  | { ok: true; answer: Record<string, unknown>; response: Response }
  | { ok: false; code: string; message: string };

/** Calls one better-auth endpoint through identity's one door (§4), with the caller's
 *  cookie, and reads its answer into a `CredentialCall`. */
async function credentialCall(
  req: Request,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<CredentialCall> {
  // deps: identity.callAuthResponse · refusalOf
  const answered = await callAuthResponse(req, endpoint, body);
  if (answered === null || !answered.ok) return { ok: false, ...(await refusalOf(answered)) };
  return { ok: true, answer: (await answered.json().catch(() => ({}))) as Record<string, unknown>, response: answered };
}

/** Where a credential write lands — the pane that drew its control, with the flash its
 *  form's 303 carried: `done=` forwarding better-auth's cookies, or `failed=` with
 *  better-auth's own words. `op` is the name that flash reports the outcome under. */
function landed(pane: string, op: string, called: CredentialCall): Response {
  return called.ok
    ? redirected(noticeUrl(pane, op, { value: null }), called.response)
    : redirected(noticeUrl(pane, op, { reason: called.message }), null);
}

/** One ops-backed settings write: `name`'s handler over the body as its whole input, landing
 *  on `pane` with `done=` — or the op's refusal as the 422 every op refusal here is. */
function opWrite(pane: string, name: "token_revoke" | "connection_revoke"): (c: Context) => Promise<Response> {
  return writer(async (session, _c, body) => {
    // Looked up per request, like every other `ops` call in this module.
    const answered = await attempt(() => ops[name].handler(session.user.userId, body));
    return "value" in answered ? redirected(noticeUrl(pane, name, answered), null) : outcome(answered);
  });
}

/**
 * What a refused credential call is worth showing, and nothing else out of the body: the
 * one line — better-auth's own `message`, which names a field ("[body.password] Invalid
 * input") and never a submitted value (§15) — and its error `code`, the stable name §13's
 * Password pane maps onto a control. Null (the call could not be made) reads as the
 * generic sentence.
 */
async function refusalOf(response: Response | null): Promise<{ code: string; message: string }> {
  const body = (await response?.json().catch(() => null)) as { code?: unknown; message?: unknown } | null;
  return {
    code: typeof body?.code === "string" ? body.code : "",
    message: typeof body?.message === "string" ? body.message : "The change was refused.",
  };
}

/** The ten codes out of a better-auth answer that carries them — a JSON array, judged by
 *  `revealedCodesOf`, so a renamed or reshaped payload reveals nothing instead of garbage. */
function answeredCodes(answer: Record<string, unknown>): string[] | null {
  const codes = answer.backupCodes;
  return Array.isArray(codes) ? revealedCodesOf(codes.map(String)) : null;
}

/** The session TOKEN behind one listed session id, read off better-auth's own listing —
 *  the read never carries a token (§15), so the pairing happens here, and the token dies
 *  with this call. Null when the id names no session of this owner. */
async function sessionTokenFor(req: Request, id: string): Promise<string | null> {
  // deps: identity.callAuth
  const listed = await callAuth<{ id: string; token: string }[]>(req, "/list-sessions");
  if (!Array.isArray(listed)) return null;
  return listed.find((session) => session.id === id)?.token ?? null;
}

/** §13's `N`: every session of this owner except the one asking, counted BEFORE the change
 *  — a successful `revokeOtherSessions` deletes them all, this one included, so nothing is
 *  left to count or to ask with afterwards, and better-auth returns no count of its own. */
async function otherSessionCount(req: Request): Promise<number> {
  // deps: identity.callAuth
  const listed = await callAuth<unknown[]>(req, "/list-sessions");
  return Array.isArray(listed) ? Math.max(0, listed.length - 1) : 0;
}

/** The op key **Update password** reports its outcome under — spelled once, because the
 *  client reads the same key back to choose §13's success copy. */
const CHANGE_PASSWORD = "change_password";

/** §13's two mapped refusal codes, as the control each is drawn beside. A code not here is
 *  not a hole: §13 sends "anything else" to the ordinary notice, and a table guessing at
 *  better-auth's other codes would be inventing copy for them. */
const PASSWORD_REFUSAL_FIELD: Record<string, PasswordField> = {
  INVALID_PASSWORD: "currentPassword",
  PASSWORD_TOO_SHORT: "newPassword",
};

/** `ChangePasswordBody`, checked field by field (a malformed body names the FIELD, never
 *  its value — §15). */
function passwordDraftOf(body: Record<string, unknown>): ChangePasswordBody | { reason: string } {
  const currentPassword = stringOf(body, "currentPassword");
  if (currentPassword === null) return { reason: "currentPassword must be a string." };
  const newPassword = stringOf(body, "newPassword");
  if (newPassword === null) return { reason: "newPassword must be a string." };
  const confirmPassword = stringOf(body, "confirmPassword");
  if (confirmPassword === null) return { reason: "confirmPassword must be a string." };
  if (typeof body.revokeOtherSessions !== "boolean") return { reason: "revokeOtherSessions must be a boolean." };
  return { currentPassword, newPassword, confirmPassword, revokeOtherSessions: body.revokeOtherSessions };
}

/** One Execution control as the op's integer: owner text that is a clean whole number
 *  becomes that number, and anything else — other text, an absent field, a non-string —
 *  reaches the op as it came, for the op to refuse (or to call required). */
function executionField(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : value;
}

/* ------------------------------------------------------------------ *
 * Catalog derivation
 * ------------------------------------------------------------------ */

/**
 * One listed declaration's description, rendered three ways by `pages/markdown.ts`.
 *
 * It is on the WIRE and not in the browser because that module is the hub's ONE audited
 * renderer of untrusted app prose — its header forbids a second implementation, and it is
 * the only place whose output a surface may treat as markup. A client-side renderer would
 * be a second whitelist to keep right; rendering plain text instead would print an app's
 * asterisks at the reader.
 *
 * Three forms because the surfaces need three: a row is one line high, a details card is
 * block structure, and a `title` attribute cannot carry markup at all.
 */
export type RenderedProse = {
  /** The first paragraph's inline formatting, as safe HTML. For a one-line row. */
  inline: string;
  /** Block structure and all, as safe HTML. For a details card. */
  block: string;
  /** The markup taken off. For a `title` / `aria-label`. */
  text: string;
};

/**
 * Everything the panes compute from ONE listed declaration, derived here because
 * `catalog-view`, `registry` and `pages/markdown` own those computations and the browser
 * must not hold a second implementation of any of them: §13's Arguments table, the dotted
 * leaf paths the Catalog details and the Recording pane's mask rows read, the `writeOnly`
 * result paths §7 masks regardless of configuration, and every description as rendered
 * markup.
 *
 * `subject` is the string a grant matches this item by — its name, or for a resource or
 * template its raw URI (§20.3: grants match resources by URI, never by name). It rides the
 * derivation because every matcher on every pane asks for it and reconstructing it in the
 * browser would be a second reading of the same rule.
 */
export type CatalogDerivation = {
  subject: string;
  /** The declaration's own prose, all three forms. The surfaces use all three: a row is one
   *  line, a details card is block structure, and an endpoint tooltip is a `title`. */
  description: RenderedProse;
  /** §13's Arguments table. No prose here: a schema property carries a type and a default,
   *  not a description — only a PROMPT's declared arguments carry one, below. */
  arguments: ArgumentRow[];
  argPaths: SchemaLeaf[];
  resultPaths: SchemaLeaf[];
  writeOnly: string[];
  /**
   * A PROMPT's declared arguments, which are the one place a per-argument description
   * exists: a prompt carries no JSON Schema at all (§20.3), so its card draws the app's own
   * declaration — name, prose, and required. Empty for every other family.
   */
  promptArguments: { name: string; description: RenderedProse; required: boolean }[];
};

function derivationOf(item: ListedItem, family: RoleFamily): CatalogDerivation {
  // `ListedItem` is gateway's own narrow view — the key the filter matches on plus the
  // outputSchema it strips — so the input schema, the description and a prompt's arguments
  // are read by narrowing rather than asserted onto it, exactly as the props builder read
  // them (model.ts:4277-4282, :4374-4383). The RESPONSE still carries each item whole, so a
  // field neither type names (a resource's `mimeType`) reaches the client untouched.
  const inputSchema = "inputSchema" in item ? item.inputSchema : undefined;
  const described = "description" in item && typeof item.description === "string" ? item.description : "";
  return {
    subject: family === "resources" ? (item.uri ?? item.uriTemplate ?? "") : (item.name ?? ""),
    description: proseOf(described),
    arguments: argumentRows(inputSchema),
    argPaths: schemaLeaves(inputSchema),
    resultPaths: schemaLeaves(item.outputSchema),
    writeOnly: writeOnlyPaths(item.outputSchema),
    promptArguments: promptArgumentsOf(item),
  };
}

/**
 * A prompt's declared arguments, read DEFENSIVELY: this is the app's own relayed
 * declaration, so nothing is trusted to be the documented shape — a missing name reads as
 * `""` and a missing description as empty prose, rather than the page printing `undefined`
 * or the render throwing on an app's malformed answer.
 */
function promptArgumentsOf(item: ListedItem): CatalogDerivation["promptArguments"] {
  const declared = "arguments" in item ? item.arguments : undefined;
  if (!Array.isArray(declared)) return [];
  return declared.map((argument: unknown) => {
    const each = typeof argument === "object" && argument !== null ? argument : {};
    const name = "name" in each && typeof each.name === "string" ? each.name : "";
    const description = "description" in each && typeof each.description === "string" ? each.description : "";
    return { name, description: proseOf(description), required: "required" in each && each.required === true };
  });
}

/** One description through the audited renderer. An empty one is three empty strings rather
 *  than three parses of nothing — every surface already draws its own em dash for it. */
function proseOf(source: string): RenderedProse {
  if (source === "") return { inline: "", block: "", text: "" };
  return { inline: inlineMarkdown(source), block: renderMarkdown(source), text: plainText(source) };
}

/** The app's committed TypeScript reservations as one comparable string, in a stable order.
 *  Compared BEFORE and AFTER a tools listing so `namesChanged` reports a real move of a
 *  committed name rather than the owner's configuration or a reasserted plan. */
async function reservedNames(appId: string): Promise<string> {
  const mapping = await new Registry(env.DB).typescriptReservationsFor(appId);
  return mapping.reservations
    .filter((row) => row.active)
    .map((row) => `${row.family}\u0000${row.canonicalName}\u0000${row.typescriptName}`)
    .sort()
    .join("\u0001");
}

/* ------------------------------------------------------------------ *
 * Body validation, and the adapters onto the composers
 * ------------------------------------------------------------------ *
 *
 * A TypeScript annotation validates nothing, so every typed route checks its body before
 * composing: each required field present and of its declared type, each array an array of
 * the element type it claims. A malformed body is a 400 naming the FIELD and never its
 * value. What is deliberately NOT checked here is meaning — path grammar, identifier
 * rules, slug charset, collisions — because `app_create` / `app_update` are the authority
 * for all of it and a second judgement here would be a second set of rules to keep aligned.
 */

/**
 * This module's own plain-object guard — a fourth private copy, like catalog-view's
 * `objectOf` and registry's `isJsonObject`, because the repo has no shared guard module
 * and a `Record<string, unknown>` proves only that a value is an object. Every field the
 * validators below read is checked individually; nothing here claims a shape.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(body: Record<string, unknown>, field: string): string | null {
  const value = body[field];
  return typeof value === "string" ? value : null;
}

function stringsOf(body: Record<string, unknown>, field: string): string[] | null {
  const value = body[field];
  if (!Array.isArray(value)) return null;
  return value.every((each) => typeof each === "string") ? (value as string[]) : null;
}

/** `/apps`' body: the add-app form's controls, plus the alias editor's rows flattened into
 *  the indexed fields `composeTypescriptAliases` reads. */
function appDraftOf(
  body: Record<string, unknown>,
):
  | { slug: string; kind: "tunnel" | "proxy"; name: string; endpoint: string; authMode: string; aliasFields: Record<string, string> }
  | { reason: string } {
  const slug = stringOf(body, "slug");
  if (slug === null) return { reason: "slug must be a string." };
  const kind = stringOf(body, "kind");
  if (kind !== "tunnel" && kind !== "proxy") return { reason: "kind must be tunnel or proxy." };
  const name = body.name === undefined ? "" : stringOf(body, "name");
  if (name === null) return { reason: "name must be a string." };
  const endpoint = body.endpoint === undefined ? "" : stringOf(body, "endpoint");
  if (endpoint === null) return { reason: "endpoint must be a string." };
  const authMode = body.authMode === undefined ? "none" : stringOf(body, "authMode");
  if (authMode === null) return { reason: "authMode must be a string." };
  const aliases = body.aliases === undefined ? { service: "", rows: [] } : body.aliases;
  const fields = aliasFieldsOf(aliases);
  if ("reason" in fields) return fields;
  return { slug, kind, name, endpoint, authMode, aliasFields: fields.fields };
}

function roleDraftOf(body: Record<string, unknown>): { draft: RoleDraft } | { reason: string } {
  const was = stringOf(body, "was");
  if (was === null) return { reason: "was must be a string." };
  const role = stringOf(body, "role");
  if (role === null) return { reason: "role must be a string." };
  const drawn = stringsOf(body, "drawn");
  if (drawn === null) return { reason: "drawn must be an array of strings." };
  const ticked = stringsOf(body, "ticked");
  if (ticked === null) return { reason: "ticked must be an array of strings." };
  const keeps = stringsOf(body, "keeps");
  if (keeps === null) return { reason: "keeps must be an array of strings." };
  const drop = body.drop === undefined ? "" : stringOf(body, "drop");
  if (drop === null) return { reason: "drop must be a string." };
  const add = body.add === undefined ? "" : stringOf(body, "add");
  if (add === null) return { reason: "add must be a string." };
  if (body.delete !== undefined && body.delete !== true) return { reason: "delete must be true or absent." };
  return {
    draft: {
      was,
      role,
      drawn,
      ticked,
      keeps,
      ...(drop === "" ? {} : { drop }),
      ...(add === "" ? {} : { add }),
      ...(body.delete === true ? { delete: true as const } : {}),
    },
  };
}

/** `RoleDraft` as the flat record `composeOwnerRoles` reads: the tick prefix is the page's
 *  own `i.`, spelled here because this is the other half of that translation. */
function roleFieldsOf(draft: RoleDraft): Record<string, string> {
  const fields: Record<string, string> = { was: draft.was, role: draft.role };
  if (draft.delete === true) fields.delete = "1";
  if (draft.drop !== undefined) fields.drop = draft.drop;
  if (draft.add !== undefined) fields.add = draft.add;
  for (const row of draft.ticked) fields[`i.${row}`] = "1";
  return fields;
}

function recordingDraftOf(body: Record<string, unknown>): { draft: RecordingDraft } | { reason: string } {
  if (typeof body.logBodies !== "boolean") return { reason: "logBodies must be a boolean." };
  const args = redactionDraftOf(body.args, "args");
  if ("reason" in args) return args;
  const results = redactionDraftOf(body.results, "results");
  if ("reason" in results) return results;
  return { draft: { logBodies: body.logBodies, args: args.draft, results: results.draft } };
}

function redactionDraftOf(value: unknown, field: string): { draft: RedactionDraft } | { reason: string } {
  if (!isRecord(value)) return { reason: `${field} must be an object.` };
  if (!Array.isArray(value.drawn)) return { reason: `${field}.drawn must be an array.` };
  const drawn: [string, string[]][] = [];
  for (const pair of value.drawn) {
    if (!Array.isArray(pair) || pair.length !== 2) return { reason: `${field}.drawn must hold [path, tools] pairs.` };
    const [path, tools] = pair as [unknown, unknown];
    if (typeof path !== "string") return { reason: `${field}.drawn must hold [path, tools] pairs.` };
    if (!Array.isArray(tools) || !tools.every((each) => typeof each === "string")) {
      return { reason: `${field}.drawn must hold [path, tools] pairs.` };
    }
    drawn.push([path, tools as string[]]);
  }
  const wholePath = stringsOf(value, "wholePath");
  if (wholePath === null) return { reason: `${field}.wholePath must be an array of strings.` };
  const perTool = stringsOf(value, "perTool");
  if (perTool === null) return { reason: `${field}.perTool must be an array of strings.` };
  return { draft: { drawn, wholePath, perTool } };
}

/** `RedactionDraft` as the flat record `composeRedaction` reads — the page's own `p.` and
 *  `m.` prefixes, spelled here for `roleFieldsOf`'s reason. */
function redactFieldsOf(draft: RedactionDraft, dir: "args" | "results"): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const path of draft.wholePath) fields[`p.${dir}.${path}`] = "1";
  for (const entry of draft.perTool) fields[`m.${dir}.${entry}`] = "1";
  return fields;
}


/** An `AliasDraft` as the indexed fields `composeTypescriptAliases` reads. Values pass
 *  through BYTE FOR BYTE: the composer's own comment says why, and trimming here would
 *  store a name nobody typed and swallow the reason to refuse it. */
function aliasFieldsOf(value: unknown): { fields: Record<string, string> } | { reason: string } {
  if (!isRecord(value)) return { reason: "aliases must be an object." };
  const service = value.service === undefined ? "" : value.service;
  if (typeof service !== "string") return { reason: "aliases.service must be a string." };
  const rows = value.rows === undefined ? [] : value.rows;
  if (!Array.isArray(rows)) return { reason: "aliases.rows must be an array." };
  const fields: Record<string, string> = { typescript_service: service };
  for (const [index, row] of rows.entries()) {
    if (!isRecord(row)) return { reason: "aliases.rows must hold objects." };
    const canonicalName = row.canonicalName === undefined ? "" : row.canonicalName;
    const alias = row.alias === undefined ? "" : row.alias;
    if (typeof canonicalName !== "string" || typeof alias !== "string") {
      return { reason: "aliases.rows must hold canonicalName and alias strings." };
    }
    fields[`canonical.${index}`] = canonicalName;
    fields[`alias.${index}`] = alias;
  }
  return { fields };
}

function grantDraftOf(body: Record<string, unknown>): { draft: GrantDraft } | { reason: string } {
  if (body.clear !== undefined && body.clear !== true) return { reason: "clear must be true or absent." };
  const entries = body.entries === undefined ? {} : body.entries;
  if (!isRecord(entries)) return { reason: "entries must be an object." };
  const checked: Record<string, "allow" | "approval" | "none"> = {};
  for (const [entry, mode] of Object.entries(entries)) {
    if (mode !== "allow" && mode !== "approval" && mode !== "none") {
      return { reason: "entries values must be allow, approval or none." };
    }
    checked[entry] = mode;
  }
  return { draft: { ...(body.clear === true ? { clear: true as const } : {}), entries: checked } };
}

/** `grant_set`'s `roles` argument, through the SAME pair of functions both form routes
 *  used: the per-row controls parsed into choices, then composed. `clear` composes to the
 *  empty list, which is how the pane revokes — the op replaces the pair's whole set. */
function rolesOf(draft: GrantDraft): string[] {
  if (draft.clear === true) return [];
  const fields: Record<string, string> = {};
  for (const [entry, mode] of Object.entries(draft.entries)) fields[`e.${entry}`] = mode;
  return composeRoles(grantChoicesOf(fields));
}

/** The browser's PushSubscription, as the push control posts it. Shape-checked here because
 *  it is a browser's word: approvals stores it verbatim and must not store junk. Only the
 *  three fields are kept, so nothing else the body carried reaches the table. */
function subscriptionOf(value: unknown): PushSubscriptionJson | null {
  if (!isRecord(value) || typeof value.endpoint !== "string" || !isRecord(value.keys)) return null;
  const { p256dh, auth } = value.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  return { endpoint: value.endpoint, keys: { p256dh, auth } };
}

/** The plaintext out of a `token_issue` answer. Structural, because the op's result shape
 *  is admin's and this surface only forwards the one field §4 shows once. */
function tokenOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("token" in value)) return null;
  return typeof value.token === "string" ? value.token : null;
}

/** One row of `agent_list`, as this module reads it back to find a named agent. */
type ListedAgent = { slug: string; grants: Record<string, string[]> };
