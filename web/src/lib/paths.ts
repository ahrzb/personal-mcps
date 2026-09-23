/**
 * The URLs the client navigates to, and the pane tables behind them.
 *
 * A COPY of `server/src/app-routes.ts`'s two pane lists and the `/apps`, `/agents`,
 * `/approvals` and `/settings` arms of `pages/model.ts`'s `paths`, for the reason `web/src/lib/types.ts` states: the client is
 * outside the Worker's dependency closure, so nothing is imported across that line. The
 * spellings are load-bearing — an existing bookmark must keep resolving — so each is
 * written here exactly as the server writes it, and the router validates against these
 * tables rather than against a second list of its own.
 */

/**
 * The seven panes `/apps/<slug>/<pane>` serves, in §2's table order. Catalog is in the list
 * and is ALSO what the landing `/apps/<slug>` renders: identical above the breakpoint, and
 * below it the landing is level 1 (the rail as a list) while `/apps/<slug>/catalog` is
 * level 2 (the listing). `/apps/<slug>/tools` is deliberately not a pane — the families
 * moved into the Catalog, so it 404s, and `/prompts` and `/resources` 301 there.
 */
export const APP_PANES = ["catalog", "roles", "recording", "overview", "access", "token", "danger"] as const;
export type AppPane = (typeof APP_PANES)[number];

/**
 * The single-segment panes `/agents/<slug>/<pane>` serves, in rail order. The agent page's
 * OTHER pane — one app's grants — is two segments (`apps/<app>`) and is therefore absent:
 * it carries an argument, so it is a route of its own, and `/agents/<slug>` renders it for
 * the first granted app in place.
 */
export const AGENT_PANES = ["grant", "credentials", "activity", "danger"] as const;
export type AgentPane = (typeof AGENT_PANES)[number];

/**
 * The rail's own labels and grouping for the app page's seven panes — §13's table,
 * verbatim from `pages/model.ts:3863-3871`. `null` is the headless tail the Danger zone
 * sits in: no heading, but a rule above it, which is how the board separates it from the
 * groups without inventing a third heading.
 *
 * No `short` column: the app and agent pill rows draw the rail's own label (only
 * /settings shortens one, and it has its own table, `SETTINGS_PANES` below).
 */
export const APP_PANE_TABLE: readonly { pane: AppPane; label: string; group: string | null }[] = [
  { pane: "catalog", label: "Catalog", group: "App" },
  { pane: "roles", label: "Roles", group: "App" },
  { pane: "recording", label: "Recording", group: "App" },
  { pane: "overview", label: "Overview", group: "App" },
  { pane: "access", label: "Agents", group: "Access" },
  { pane: "token", label: "Token", group: "Access" },
  { pane: "danger", label: "Danger zone", group: null },
];

/** The agent rail's fixed tail. Its HEAD is the agent's granted apps, one entry each under
 *  an `Apps · N` heading, so the table cannot be static the way the app one is — the page
 *  builds those entries from the grants it read. */
export const AGENT_GROUP = "Agent";

/** A search bag as a query string, or "" — the one spelling, so a hand-built `/audit?…` cannot
 *  differ from what `router.tsx`'s codec would write and read back. */
function query(search: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (Array.isArray(value)) for (const each of value) params.append(key, each);
    else params.set(key, value);
  }
  const written = params.toString();
  return written === "" ? "" : `?${written}`;
}

export const paths = {
  apps: "/apps",
  appNew: "/apps/new",
  agents: "/agents",
  agentNew: "/agents/new",
  /**
   * The explorer, optionally carrying a selection. A FUNCTION rather than a bare string
   * because every link to this page carries state now: the agent page's `?principal=`, the
   * app page's `?app=`, a record's `?expand=` and the page's own `searchOf(selection)` are all
   * this one path plus keys — and `/audit` itself is `paths.audit()`.
   *
   * Repeated keys ride as arrays, exactly as `router.tsx`'s `stringifySearch` writes them.
   */
  audit: (search: Record<string, string | string[]> = {}): string => `/audit${query(search)}`,
  approvals: "/approvals",
  settings: "/settings",
  /** The device-flow verdict page the CLI prints (`verification_uri`), and its
   *  `?user_code=` deep link (`verification_uri_complete`). */
  device: "/device",
  /**
   * The consent screen (§19.5), and the target of its KEPT form POST: that POST answers a 303
   * to the client's own redirect_uri, which a `fetch` cannot carry into the address bar.
   */
  oauthConsent: "/oauth/consent",
  /** The sign-out target — a real form POST, because the answer is Set-Cookie plus a 303 to
   *  /login. The WORKER's translating route, not better-auth's `/api/auth/sign-out`: that one
   *  refuses a control-less form body with 415 and answers JSON, which is what this form
   *  posted until 2026-09-23 — sign-out on every SPA page failed (web.ts, paths.auth.signOut). */
  signOut: "/login/sign-out",
  /** §8's one browser-only interaction, kept as a server route: it answers a 303 to a
   *  third-party authorize URL, and a `fetch` cannot follow a cross-origin redirect into
   *  the address bar — so the client renders a real `<form method="post">` at it. */
  appConnect: (slug: string): string => `/apps/connect?slug=${encodeURIComponent(slug)}`,
  appPane: (slug: string, pane: AppPane): string => `/apps/${encodeURIComponent(slug)}/${pane}`,
  appDetail: (slug: string): string => `/apps/${encodeURIComponent(slug)}`,
  agentPane: (slug: string, pane: AgentPane): string => `/agents/${encodeURIComponent(slug)}/${pane}`,
  agentDetail: (slug: string): string => `/agents/${encodeURIComponent(slug)}`,
  agentApp: (slug: string, app: string): string =>
    `/agents/${encodeURIComponent(slug)}/apps/${encodeURIComponent(app)}`,
  approval: (id: string): string => `/approvals/${encodeURIComponent(id)}`,
  /** One /settings pane's own URL. The landing pane (Password) is `/settings` itself and
   *  has no alias — `/settings/password` is the Worker's 404. */
  settingsPane: (pane: SettingsPane): string => (pane === "password" ? "/settings" : `/settings/${pane}`),
  /** A pane with one destructive dialog open: `?confirm=` rides the URL of the pane that
   *  OWNS the control (`SETTINGS_CONFIRM_PANE`), and `id` names the row where there is one. */
  settingsConfirm: (pane: SettingsPane, kind: SettingsConfirmKind, id?: string): string =>
    `/settings${pane === "password" ? "" : `/${pane}`}${query(id === undefined ? { confirm: kind } : { confirm: kind, id })}`,
} as const;

/**
 * §13's seven /settings panes, in rail order — also the phone's pill order. `label` is the
 * rail's and `short` the pill's (they differ for Connected clients alone); `group` is the
 * rail heading. `pages/model.ts`'s `SETTINGS_PANES`, verbatim.
 */
export const SETTINGS_PANES = [
  { pane: "password", label: "Password", short: "Password", group: "Sign-in" },
  { pane: "two-factor", label: "Two-factor", short: "Two-factor", group: "Sign-in" },
  { pane: "passkeys", label: "Passkeys", short: "Passkeys", group: "Sign-in" },
  { pane: "sessions", label: "Sessions", short: "Sessions", group: "Access" },
  { pane: "tokens", label: "Tokens", short: "Tokens", group: "Access" },
  { pane: "clients", label: "Connected clients", short: "Clients", group: "Access" },
  { pane: "execution", label: "Execution", short: "Execution", group: "Runtime" },
] as const;
export type SettingsPane = (typeof SETTINGS_PANES)[number]["pane"];

/** The five destructive confirmations /settings asks, by their `?confirm=` word. */
export type SettingsConfirmKind =
  | "disable-two-factor"
  | "remove-passkey"
  | "revoke-session"
  | "revoke-other-sessions"
  | "revoke-connection";

/**
 * Which pane OWNS each confirmation — where its link is drawn, where its dialog opens and
 * where its write lands back. One table, so the same `?confirm=` carried to another pane's
 * URL is no dialog at all (`pages/model.ts`'s `SETTINGS_CONFIRM_PANE`).
 */
export const SETTINGS_CONFIRM_PANE: Record<SettingsConfirmKind, SettingsPane> = {
  "disable-two-factor": "two-factor",
  "remove-passkey": "passkeys",
  "revoke-session": "sessions",
  "revoke-other-sessions": "sessions",
  "revoke-connection": "clients",
};

/**
 * /settings' JSON surface, relative to `/api/hub` as `ApiClient` takes it — the one read and
 * the eleven writes (routes design §2), each the old form target's own path under the
 * `/api/hub/settings/*` recent-auth prefix.
 *
 * Also a SERVER contract: `server/test/worker/web-pages.test.ts` imports this table and walks
 * every entry against the Worker, so a write the client posts and no route answers fails
 * there rather than on a phone.
 */
export const settingsApi = {
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
} as const;

/**
 * /device's JSON surface, relative to `/api/hub` (routes design §3): the read that claims and
 * describes a code, and the decision. The read is `read` plus `?user_code=`.
 */
export const deviceApi = {
  read: "/device",
  decide: "/device/decide",
} as const;

/**
 * /oauth/consent's one read, relative to `/api/hub` (routes design §4). The signed query is
 * appended to it VERBATIM — the document's own raw search, never parsed, rebuilt or
 * re-encoded — because the provider re-verifies its signature byte for byte on every read.
 */
export const consentApi = {
  read: "/oauth/consent",
} as const;

/**
 * better-auth's two passkey REGISTRATION endpoints, which the Passkeys pane's **Add passkey**
 * calls directly: a WebAuthn ceremony is two fetches with the browser's authenticator between
 * them, not a form, so there is nothing for a hub route to translate. better-auth's own
 * `freshSessionMiddleware` guards both.
 */
export const passkeyRegistration = {
  options: "/api/auth/passkey/generate-register-options",
  verify: "/api/auth/passkey/verify-registration",
} as const;

/** §2's reserved role: granted like any other, declared by nobody, and the one the listing
 *  marks `built-in`. */
export const BUILTIN_ROLE = "all";

/** The wire spelling of approval mode in a grant entry (§8). */
export const APPROVAL_SUFFIX = ":approval";

/** The rail marker for "advertises none" — an em dash, and never the empty string, which
 *  means "could not be read" (§13: an unread count is not an empty set). */
export const DIMMED = "—";
