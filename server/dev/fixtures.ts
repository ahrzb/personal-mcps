// fixtures.ts — every page state, as data.
//
// One namespace ("ahrzb"), one render instant (NOW), and one cast of apps
// and agents, so a reviewer flipping between pages sees a coherent hub rather
// than eight unrelated screenshots. Each entry is a complete, type-checked
// value of its page's Props: if model.ts changes shape, this file is where the
// break surfaces — before any template is touched.
//
// Nothing here is real. Tokens use an obviously-fake body (FAKE0000…) so a
// grep for a leaked credential can never land on this file, and every argument
// value that the hub would mask is already spelled "‹redacted›" — fixtures show
// the post-redaction form because that is the only form the hub ever stores or
// displays (§7).
//
// Coverage rule: one rich default per page plus one fixture per distinct state
// the artboards show — empty lists, error banners and field errors, the
// once-only token reveal, needs-reconnect, offline, expired and spent approvals,
// oversize audit bodies — and a long-content fixture wherever text can overflow.

import type {
  ConnectionRow,
  ConsentProps,
  SettingsProps,
  ShellProps,
  TokenRow,
  ApprovalDetailProps,
  ApprovalRow,
  ApprovalsProps,
  AuditEventRow,
  AuditHistogram,
  AuditProps,
  DeviceProps,
  LoginProps,
  NavSection,
  Notice,
  PagePropsByName,
  PasskeyRow,
  AppAgentRow,
  AppDetailHeader,
  AppDetailPane,
  AppDetailProps,
  AgentDetailProps,
  AgentNewProps,
  AgentRow,
  AgentsProps,
  AgentActivityDetails,
  AgentApprovalRow,
  AgentCallRow,
  AgentClientRow,
  AgentCredentialsDetails,
  AgentDetailsView,
  AgentEndpointRow,
  AgentGrantCard,
  AgentHeader,
  AgentListGroup,
  AgentPaneView,
  AgentRailEntry,
  AgentTokenRow,
  GrantChoice,
  RowControl,
  AppNewProps,
  AppPromptRow,
  AppRailEntry,
  AppResourceRow,
  AppRow,
  AppsProps,
  AppTokenRow,
  AppToolRow,
  SessionRow,
} from "../src/pages/model";
// The dimmed marker is a VALUE, not a spelling: model.ts owns the glyph so nothing can
// decide what "advertises none" looks like twice (§13).
// `enrollmentOf` is the ONE producer of an enrolment's three fields (§13/§15's own rule) —
// fixtures call it rather than hand-rolling a QR, so the preview can never draw a secret,
// a grouped display form and a QR that disagree with one another.
// `familyMarker` is §13's three-answer family marker (a count, `—` where the app advertises
// none, BLANK where a listing could not be read at all) — this IS the shipped rule, not a
// copy of it, because the preview must demonstrate what the page does.
import { DIMMED, agentLevel, enrollmentOf, familyMarker } from "../src/pages/model";
import { HUB_PRINCIPAL } from "../src/principal";

/* ------------------------------------------------------------------ *
 * Shared scaffolding
 * ------------------------------------------------------------------ */

/** Epoch milliseconds from a readable instant — registry and audit spell time this way. */
const ms = (iso: string): number => Date.parse(iso);

/** The instant every fixture is rendered at: 17 minutes after the oldest pending approval. */
const NOW = "2026-08-24T14:47:00.000Z";

const HOUR = 60 * 60 * 1000;

/**
 * The signed-in shell, with the section narrowed to the page that asks for it so
 * each page's `section` literal survives.
 */
const shell = <S extends NavSection>(
  section: S,
  pendingApprovals = 2,
  notice: Notice | null = null,
) => ({ now: NOW, username: "ahrzb", section, pendingApprovals, notice });

/** A CSRF token is opaque to every template; one obviously-fake value is enough. */
const CSRF = "csrf_FAKE0000d41d8cd98f00b204e9800998";

/* ------------------------------------------------------------------ *
 * /login
 * ------------------------------------------------------------------ */

const login = {
  /** First visit: an empty credentials form with the passkey alternative. */
  default: {
    now: NOW,
    step: { kind: "credentials", username: "", error: null },
    redirectTo: null,
  },

  /** AuthStates "LOGIN — ERROR": the username survives, the password does not. */
  credentialsError: {
    now: NOW,
    step: {
      kind: "credentials",
      username: "ahrzb",
      error: "Wrong username or password.",
    },
    redirectTo: null,
  },

  /** Password accepted, second factor demanded; bounced here from a push link. */
  totp: {
    now: NOW,
    step: { kind: "totp", error: null },
    redirectTo: "/approvals/apr_8f2k",
  },

  /** AuthStates "TWO-FACTOR — ERROR". */
  totpError: {
    now: NOW,
    step: {
      kind: "totp",
      error: "That code didn't work. Codes rotate every 30 seconds.",
    },
    redirectTo: null,
  },

  /** AuthStates "BACKUP CODE": the same challenge, spelled the other way. */
  backupCode: {
    now: NOW,
    step: { kind: "backup-code", error: null },
    redirectTo: null,
  },

  /** A spent or mistyped backup code. */
  backupCodeError: {
    now: NOW,
    step: { kind: "backup-code", error: "That backup code has already been used." },
    redirectTo: null,
  },
} satisfies Record<string, LoginProps>;

/* ------------------------------------------------------------------ *
 * /device
 * ------------------------------------------------------------------ */

const device = {
  /** The verdict screen: a live request from the CLI, 4 seconds old. */
  default: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "confirm",
      request: {
        userCode: "BDWJ-KTQP",
        ip: "203.0.113.42",
        client: "pmcp CLI on Windows",
        requestedAt: "2026-08-24T14:46:56.000Z",
        expiresAt: "2026-08-24T14:56:56.000Z",
      },
    },
  },

  /** AuthStates "DEVICE — ENTER CODE": arrived at /device without a code. */
  enterCode: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: { kind: "enter-code", userCode: "", error: null },
  },

  /** AuthStates "DEVICE — EXPIRED CODE": same step, recovery is a new code. */
  expiredCode: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "enter-code",
      userCode: "BDWJ-KTQP",
      error: "That code has expired — run pmcp login again for a new one.",
    },
  },

  /** AuthStates "DEVICE — APPROVED". */
  approved: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: { kind: "decided", decision: "approved" },
  },

  /** The same shape with the opposite verdict — the CLI is told, and stops. */
  denied: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: { kind: "decided", decision: "denied" },
  },
} satisfies Record<string, DeviceProps>;

/* ------------------------------------------------------------------ *
 * /settings
 * ------------------------------------------------------------------ */

// Every name here is one `passkeyRow` (model.ts) can actually produce: the ceremony sends
// no name of its own, so a row reads either the plugin's own AAGUID table
// (`@better-auth/passkey/dist/index.mjs:739-753`) or, for an AAGUID the table does not
// have — or the all-zero one privacy-preserving platforms report — the literal "Passkey".
// The third row is that steady state: the most common real render, and the one no fixture
// drew before this (orphan note).
const passkeys: PasskeyRow[] = [
  {
    id: "pk_7f2a91",
    name: "Windows Hello",
    addedAt: "2026-03-12T09:14:00.000Z",
    lastUsedAt: "2026-08-23T21:02:00.000Z",
  },
  {
    id: "pk_1c8e40",
    name: "Google Password Manager",
    addedAt: "2026-01-08T17:40:00.000Z",
    lastUsedAt: "2026-08-02T08:25:00.000Z",
  },
  {
    id: "pk_9a04dd",
    name: "Passkey",
    addedAt: "2026-06-30T13:05:00.000Z",
    lastUsedAt: "2026-08-18T19:22:00.000Z",
  },
];

const sessions: SessionRow[] = [
  {
    id: "ses_9d21ba",
    client: "Chrome on Windows",
    source: "web",
    // Minted 4 minutes before NOW: the Password pane sits behind §13's recent-auth gate
    // and prints this difference, so a stale current session would make the one pane that
    // demonstrates the freshness line demonstrate a stale one.
    createdAt: "2026-08-24T14:43:00.000Z",
    lastActiveAt: NOW,
    current: true,
  },
  {
    id: "ses_4a77c0",
    client: "pmcp CLI",
    source: "cli",
    createdAt: "2026-08-20T19:31:00.000Z",
    lastActiveAt: "2026-08-24T12:47:00.000Z",
    current: false,
  },
  {
    id: "ses_2b09fe",
    client: "Safari on iPhone",
    source: "web",
    createdAt: "2026-08-11T07:12:00.000Z",
    lastActiveAt: "2026-08-21T10:05:00.000Z",
    current: false,
  },
];

/** better-auth's own `otpauth://` shape — the same string `/two-factor/enable` mints, with
 *  a fake-but-well-formed secret. `enrollmentOf` is what turns this into the QR and the
 *  grouped display form, exactly as the live route does, so the preview cannot draw a QR
 *  the secret does not encode. */
const TOTP_URI = "otpauth://totp/personal-mcps:owner?secret=JBSWY3DPEHPK3PXP&issuer=personal-mcps";

/** better-auth's own shape — two five-character alphanumeric halves, ten of them
 *  (`backup-codes/index.mjs:14-16`), not the eight four-character halves fabricated here
 *  before (orphan note). */
const BACKUP_CODES = [
  "a1b2c-3d4e5",
  "f6g7h-8i9j0",
  "k1l2m-3n4o5",
  "p6q7r-8s9t0",
  "u1v2w-3x4y5",
  "z6a7b-8c9d0",
  "e1f2g-3h4i5",
  "j6k7l-8m9n0",
  "o1p2q-3r4s5",
  "t6u7v-8w9x0",
];

const tokens: TokenRow[] = [
  {
    id: "tok_4kJk9fQ",
    prefix: "pmcp_agt_4kJk…9fQ",
    kind: "agent",
    boundTo: "claude",
    createdAt: ms("2026-08-12T09:00:00.000Z"),
    expiresAt: ms("2026-11-10T09:00:00.000Z"),
    lastUsedAt: ms("2026-08-24T12:47:00.000Z"),
    expired: false,
  },
  {
    // SettingsTokens' second row: issued and never presented, so `last_used_at` is still
    // null — the Last used column's other cell, which no other fixture draws.
    id: "tok_7Qm2Lx8",
    prefix: "pmcp_agt_7Qm2…Lx8",
    kind: "agent",
    boundTo: "cron",
    createdAt: ms("2026-08-20T16:05:00.000Z"),
    expiresAt: ms("2026-11-18T16:05:00.000Z"),
    lastUsedAt: null,
    expired: false,
  },
  {
    id: "tok_9f3kXd2",
    prefix: "pmcp_app_9f3k…Xd2",
    kind: "app",
    boundTo: "news",
    createdAt: ms("2026-08-14T11:20:00.000Z"),
    expiresAt: null,
    lastUsedAt: ms("2026-08-24T14:46:00.000Z"),
    expired: false,
  },
  {
    id: "tok_2xPvQc7",
    prefix: "pmcp_agt_2xPv…Qc7",
    kind: "agent",
    boundTo: "cron",
    createdAt: ms("2026-05-03T08:00:00.000Z"),
    expiresAt: ms("2026-06-28T08:00:00.000Z"),
    lastUsedAt: ms("2026-06-28T07:00:00.000Z"),
    expired: true,
  },
];

const connections: ConnectionRow[] = [
  {
    id: "con_claude01",
    clientId: "client_claude_ai",
    clientName: "Claude",
    agentSlug: "claude",
    createdAt: ms("2026-08-24T10:00:00.000Z"),
    lastUsedAt: ms("2026-08-24T14:45:00.000Z"),
    revokedAt: null,
    redirectOrigin: "https://claude.ai",
    selfRegistered: false,
  },
  {
    id: "con_acme001",
    clientId: "client_acme_agent",
    clientName: "Acme Agent",
    agentSlug: "cron",
    createdAt: ms("2026-08-12T06:30:00.000Z"),
    lastUsedAt: ms("2026-08-28T06:30:00.000Z"),
    revokedAt: ms("2026-08-28T07:00:00.000Z"),
    redirectOrigin: "https://agent.acme.dev",
    selfRegistered: true,
  },
];

/**
 * What every settings fixture repeats. The rail is drawn on every pane from every list,
 * so a fixture that carried only its own pane's rows would render a rail full of zeroes —
 * which is exactly the disagreement §13's shell rule forbids.
 */
const settingsBase: Omit<SettingsProps, keyof ShellProps | "section" | "pane"> = {
  csrfToken: CSRF,
  twoFactor: { enabled: true },
  enrollment: null,
  revealedBackupCodes: null,
  passkeys,
  sessions,
  tokens,
  tokenKind: null,
  connections,
  confirm: null,
  passwordError: null,
};

const settings = {
  /** Fully secured, landing on Password: TOTP on, two passkeys, three live sessions. */
  default: { ...shell("settings"), ...settingsBase, pane: "password" },

  /** SettingsStates' three Password refusals, one fixture each — §13 maps each onto its
   *  own control, so a single "refused" state would draw none of them. Each carries the
   *  ordinary redirect-back notice beside its field error, exactly as the route leaves it:
   *  better-auth's own words at the top, §13's sentence beside the control. */
  passwordWrongCurrent: {
    ...shell("settings", 2, {
      tone: "danger",
      title: "Change password failed",
      message: "Invalid password",
    }),
    ...settingsBase,
    pane: "password",
    passwordError: "currentPassword",
  },
  passwordTooShort: {
    ...shell("settings", 2, {
      tone: "danger",
      title: "Change password failed",
      message: "Password too short",
    }),
    ...settingsBase,
    pane: "password",
    passwordError: "newPassword",
  },
  passwordMismatch: {
    ...shell("settings", 2, {
      tone: "danger",
      title: "Change password failed",
      message: "The change was refused.",
    }),
    ...settingsBase,
    pane: "password",
    passwordError: "confirmPassword",
  },

  /** §13's "anything else is the ordinary refusal notice" — the refusal that names no
   *  control, which is the only Password refusal drawn as a banner. */
  passwordRefused: {
    ...shell("settings", 2, {
      tone: "danger",
      title: "Change password failed",
      message: "Password too long",
    }),
    ...settingsBase,
    pane: "password",
  },

  /** The two success states, which differ in exactly the sentence the checkbox buys. */
  passwordUpdated: {
    ...shell("settings", 2, {
      tone: "success",
      title: "Password updated.",
      message: "App and agent tokens keep working: they do not derive from the password.",
    }),
    ...settingsBase,
    pane: "password",
  },
  passwordUpdatedSignedOut: {
    ...shell("settings", 2, {
      tone: "success",
      title: "Password updated.",
      message:
        "2 other session(s) were signed out — this one stays. App and agent tokens keep working: they do not derive from the password.",
    }),
    ...settingsBase,
    pane: "password",
    // The truth §13 pins beside that copy: afterwards there is one session, minted by the
    // change itself, and no other row to revoke.
    sessions: [sessions[0]!],
  },

  /** One fixture per pane, so the preview index walks all six of §13's routes. */
  twoFactor: { ...shell("settings"), ...settingsBase, pane: "two-factor" },
  passkeys: { ...shell("settings"), ...settingsBase, pane: "passkeys" },
  sessions: { ...shell("settings"), ...settingsBase, pane: "sessions" },
  tokens: { ...shell("settings"), ...settingsBase, pane: "tokens" },
  clients: { ...shell("settings"), ...settingsBase, pane: "clients" },

  /** SettingsStates "Two-factor — not enrolled": the rail dot unlit beside it. */
  bare: {
    ...shell("settings", 0),
    ...settingsBase,
    pane: "two-factor",
    twoFactor: { enabled: false },
    passkeys: [],
    sessions: [sessions[0]!],
  },

  /** SettingsPanes "Passkeys — empty". */
  passkeysEmpty: {
    ...shell("settings", 0),
    ...settingsBase,
    pane: "passkeys",
    passkeys: [],
  },

  /** A registered passkey that has never signed anybody in — §5's `last_used_at` still
   *  null, which is every passkey's state until its first assertion stamps it. */
  passkeysNeverUsed: {
    ...shell("settings"),
    ...settingsBase,
    pane: "passkeys",
    passkeys: passkeys.map((pk) => ({ ...pk, lastUsedAt: null })),
  },

  /** Both Access panes with nothing in them. */
  tokensEmpty: { ...shell("settings", 0), ...settingsBase, pane: "tokens", tokens: [] },
  clientsEmpty: { ...shell("settings", 0), ...settingsBase, pane: "clients", connections: [] },

  /** SettingsTokens under each half of §13's **All · Agents · Apps** filter — the table
   *  narrows, the rail's count does not (it is the whole listed set either way). */
  tokensAgents: { ...shell("settings"), ...settingsBase, pane: "tokens", tokenKind: "agent" },
  tokensApps: { ...shell("settings"), ...settingsBase, pane: "tokens", tokenKind: "app" },

  /** The filter narrowed to a kind this namespace holds none of: the empty state a live
   *  pane can reach without the namespace being empty. */
  tokensFilteredEmpty: {
    ...shell("settings"),
    ...settingsBase,
    pane: "tokens",
    tokenKind: "app",
    tokens: tokens.filter((token) => token.kind === "agent"),
  },

  /** SettingsPanes "Connected clients" with a live row only — the revoked, unverified
   *  second row of `connections` is what the default `clients` fixture draws beside it. */
  clientsActiveOnly: {
    ...shell("settings"),
    ...settingsBase,
    pane: "clients",
    connections: [connections[0]!],
  },

  /** SettingsStates "TOTP setup": mid-enrollment, nothing stored yet. */
  totpEnrolling: {
    ...shell("settings", 0),
    ...settingsBase,
    pane: "two-factor",
    twoFactor: { enabled: false },
    enrollment: enrollmentOf(TOTP_URI, null)!,
    passkeys: [],
    sessions: [sessions[0]!],
  },

  /** The enrollment code did not verify — the setup card re-renders with the error, which
   *  is better-auth's own two-word sentence (`totp/index.mjs`'s `INVALID_CODE`), not
   *  hand-written copy. */
  totpEnrollError: {
    ...shell("settings", 0),
    ...settingsBase,
    pane: "two-factor",
    twoFactor: { enabled: false },
    enrollment: enrollmentOf(TOTP_URI, "Invalid code")!,
    passkeys: [],
    sessions: [sessions[0]!],
  },

  /** SettingsStates "Backup codes": the one render that ever shows them. In-place, on the
   *  POST's own 200 — there is no flash to read on that answer, so this carries none. */
  backupCodesRevealed: {
    ...shell("settings", 0),
    ...settingsBase,
    pane: "two-factor",
    revealedBackupCodes: BACKUP_CODES,
    passkeys: [],
    sessions: [sessions[0]!],
  },

  /** Dialogs "Disable two-factor" — password-confirmed, destructive. */
  confirmDisableTwoFactor: {
    ...shell("settings"),
    ...settingsBase,
    pane: "two-factor",
    confirm: { kind: "disable-two-factor" },
  },

  /** Dialogs "Remove passkey". */
  confirmRemovePasskey: {
    ...shell("settings"),
    ...settingsBase,
    pane: "passkeys",
    confirm: { kind: "remove-passkey", id: "pk_7f2a91", name: "Windows Hello" },
  },

  /** Dialogs, same pattern: revoking the CLI's device-flow session. */
  confirmRevokeSession: {
    ...shell("settings"),
    ...settingsBase,
    pane: "sessions",
    confirm: { kind: "revoke-session", id: "ses_4a77c0", label: "pmcp CLI · device flow" },
  },

  /** The one confirmation that names no row (§13's Revoke all others). */
  confirmRevokeOtherSessions: {
    ...shell("settings"),
    ...settingsBase,
    pane: "sessions",
    confirm: { kind: "revoke-other-sessions" },
  },

  /** Dialogs, on the Connected clients pane. */
  confirmRevokeConnection: {
    ...shell("settings"),
    ...settingsBase,
    pane: "clients",
    confirm: { kind: "revoke-connection", id: "con_claude01", client: "Claude" },
  },

  /** A failed better-auth mutation redirected back with its reason — `noticeOf`'s own
   *  title (`${humanize(failed)} failed`) and better-auth's own INVALID_PASSWORD message,
   *  the same one `passwordWrongCurrent` carries verbatim; both halves were hand-written
   *  copy before this (orphan note). */
  error: {
    ...shell("settings", 2, {
      tone: "danger",
      title: "Two factor disable failed",
      message: "Invalid password",
    }),
    ...settingsBase,
    pane: "two-factor",
  },

  /** Edge: a user agent nobody sized a column for. No passkey name belongs here — every
   *  one a real row can carry is short, from `passkeyRow`'s own fixed table or the literal
   *  "Passkey" (retired: a hand-invented long authenticator name no ceremony ever sends). */
  longNames: {
    ...shell("settings"),
    ...settingsBase,
    pane: "passkeys",
    sessions: [
      sessions[0]!,
      {
        id: "ses_long01",
        client:
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 — self-reported, never parsed",
        source: "web",
        createdAt: "2026-08-19T04:00:00.000Z",
        lastActiveAt: "2026-08-24T14:40:00.000Z",
        current: false,
      },
    ],
  },
} satisfies Record<string, SettingsProps>;

/* ------------------------------------------------------------------ *
 * /apps
 * ------------------------------------------------------------------ */

const news: AppRow = {
  slug: "news",
  name: "News MCP",
  kind: "tunnel",
  archived: false,
  upstreamUrl: null,
  upstreamAuthMode: null,
  lastConnectedAt: ms("2026-08-24T14:46:41.000Z"),
  roleNames: ["reader", "admin"],
  connection: "online",
  upstream: null,
  tokenCount: 2,
};

const notion: AppRow = {
  slug: "notion",
  name: "Notion",
  kind: "proxy",
  archived: false,
  upstreamUrl: "https://mcp.notion.com/mcp",
  upstreamAuthMode: "headers",
  lastConnectedAt: null,
  roleNames: ["editor", "reader"],
  connection: null,
  upstream: "connected",
  tokenCount: 0,
};

const linear: AppRow = {
  slug: "linear",
  name: "Linear",
  kind: "proxy",
  archived: false,
  upstreamUrl: "https://mcp.linear.app/mcp",
  upstreamAuthMode: "oauth",
  lastConnectedAt: null,
  roleNames: ["reader"],
  connection: null,
  upstream: "connected",
  tokenCount: 0,
};

const github: AppRow = {
  slug: "github",
  name: "GitHub",
  kind: "proxy",
  archived: false,
  upstreamUrl: "https://api.githubcopilot.com/mcp",
  upstreamAuthMode: "oauth",
  lastConnectedAt: null,
  roleNames: ["reader", "triage"],
  connection: null,
  upstream: "needs_reconnect",
  tokenCount: 0,
};

const slack: AppRow = {
  slug: "slack",
  name: "Slack",
  kind: "proxy",
  archived: false,
  upstreamUrl: "https://mcp.slack.com/mcp",
  upstreamAuthMode: "oauth",
  lastConnectedAt: null,
  roleNames: ["reader"],
  connection: null,
  upstream: "not_connected",
  tokenCount: 0,
};

/** Provisioned but never dialed in: no declaration, so no declared roles. */
const weather: AppRow = {
  slug: "weather",
  name: "Weather bot",
  kind: "tunnel",
  archived: false,
  upstreamUrl: null,
  upstreamAuthMode: null,
  lastConnectedAt: null,
  roleNames: [],
  connection: "offline",
  upstream: null,
  tokenCount: 1,
};

const home: AppRow = {
  slug: "home",
  name: "Home automation",
  kind: "tunnel",
  archived: true,
  upstreamUrl: null,
  upstreamAuthMode: null,
  lastConnectedAt: ms("2026-08-20T21:14:00.000Z"),
  roleNames: [],
  connection: "offline",
  upstream: null,
  tokenCount: 1,
};

const apps = {
  /** The full board: every kind, every status, plus the archived section. */
  default: {
    ...shell("apps"),
    csrfToken: CSRF,
    active: [news, notion, linear, github, slack, weather],
    archived: [home],
    confirm: null,
  },

  /** EmptyStates "Apps — empty": a fresh namespace. */
  empty: {
    ...shell("apps", 0),
    csrfToken: CSRF,
    active: [],
    archived: [],
    confirm: null,
  },

  /** Nothing live, everything parked — the archived section carrying the page. */
  allArchived: {
    ...shell("apps", 0),
    csrfToken: CSRF,
    active: [],
    archived: [home, { ...weather, archived: true }],
    confirm: null,
  },

  /** Dialogs "Delete app": the copy names the token count it will revoke. */
  confirmDelete: {
    ...shell("apps"),
    csrfToken: CSRF,
    active: [news, notion, linear, github, slack, weather],
    archived: [home],
    confirm: { kind: "delete-app", row: news },
  },

  /** A Connect attempt that came back from the provider without a credential. */
  connectFailed: {
    ...shell("apps", 2, {
      tone: "danger",
      title: "Could not connect GitHub",
      message:
        "The provider did not complete the sign-in. Nothing was stored — try Reconnect.",
    }),
    csrfToken: CSRF,
    active: [news, notion, linear, github, slack, weather],
    archived: [home],
    confirm: null,
  },

  /** The happy redirect-back after an archive. */
  archivedNotice: {
    ...shell("apps", 2, {
      tone: "success",
      message: "home is archived. Its roles, grants, and tokens are kept.",
    }),
    csrfToken: CSRF,
    active: [news, notion, linear, github, slack],
    archived: [home],
    confirm: null,
  },

  /** Edge: names, slugs, endpoints, and role lists past every column's comfort. */
  longNames: {
    ...shell("apps"),
    csrfToken: CSRF,
    active: [
      {
        slug: "internal-observability-and-incident-response-toolkit",
        name: "Internal observability and incident response toolkit (staging mirror)",
        kind: "proxy",
        archived: false,
        upstreamUrl:
          "https://mcp.internal.example.com/observability/incident-response/v2/streamable-http?tenant=staging-mirror",
        upstreamAuthMode: "oauth",
        lastConnectedAt: null,
        roleNames: [
          "reader",
          "incident-responder",
          "dashboard-editor",
          "alert-router",
          "postmortem-author",
          "oncall-scheduler",
        ],
        connection: null,
        upstream: "needs_reconnect",
        tokenCount: 0,
      },
      news,
    ],
    archived: [],
    confirm: null,
  },
} satisfies Record<string, AppsProps>;

/* ------------------------------------------------------------------ *
 * /apps/<slug>
 * ------------------------------------------------------------------ */

/** The tunneled app's own catalog, as the AppDetail board draws it: four collapsed rows
 *  and one expanded, so every branch of the Tools row is on screen at once. */
const mcpToolsCatalog: AppToolRow[] = [
  {
    name: "paper_fetch",
    aggregated: "mcp-tools_paper_fetch",
    summary: "Fetch the paper identified by a DOI and return its text as Markdown.",
    description:
      "Fetch the paper identified by a DOI and return its text as Markdown.\ndoi must be the exact DOI string, not a URL or a padded value.",
    args: [
      { name: "doi", type: "string", required: true, hasDefault: false },
      { name: "force_refresh", type: "boolean", required: false, hasDefault: true, default: false },
    ],
    reach: [{ agent: "claude", mode: "allow", roles: ["all"] }],
    approvalAgents: [],
    redactedArgs: [],
    redactedResults: [],
    schemaUnsound: false,
  },
  {
    name: "jobfeed_crawl",
    aggregated: "mcp-tools_jobfeed_crawl",
    summary: "Trigger a crawl of the configured job boards.",
    description: "Trigger a crawl of the configured job boards.",
    args: [{ name: "board", type: "string", required: false, hasDefault: false }],
    reach: [
      { agent: "claude", mode: "approval", roles: ["crawler"] },
      { agent: "pi", mode: "allow", roles: ["crawler", "both"] },
    ],
    approvalAgents: ["claude"],
    redactedArgs: [],
    redactedResults: [],
    schemaUnsound: false,
  },
  {
    name: "secret_push",
    aggregated: "mcp-tools_secret_push",
    summary: "Push a secret to the configured store.",
    description: "Push a secret to the configured store.",
    args: [
      { name: "credentials", type: "object", required: true, hasDefault: false },
      { name: "payload", type: "object", required: true, hasDefault: false },
    ],
    reach: [],
    approvalAgents: [],
    redactedArgs: ["credentials.token", "payload.key"],
    redactedResults: ["out.token"],
    schemaUnsound: false,
  },
  {
    name: "bad_schema",
    aggregated: "mcp-tools_bad_schema",
    summary: "A tool whose schema the hub will not resolve.",
    description: "A tool whose schema the hub will not resolve.",
    args: [],
    reach: [],
    approvalAgents: [],
    redactedArgs: [],
    redactedResults: [],
    schemaUnsound: true,
  },
];

const tunnelHeader: AppDetailHeader = {
  name: "mcp-tools",
  slug: "mcp-tools",
  kind: "tunnel",
  archived: false,
  status: "online",
  lastSeen: ms(NOW),
  endpoint: null,
  authMode: null,
  forwardIdentity: null,
  connect: null,
  disconnect: null,
};

/** AppDetailStates "PROXIED · OAUTH": connected, so Reconnect sits beside Disconnect. */
const proxiedHeader: AppDetailHeader = {
  name: "Linear",
  slug: "linear",
  kind: "proxy",
  archived: false,
  status: "connected",
  lastSeen: null,
  endpoint: "https://mcp.linear.app/mcp",
  authMode: "oauth",
  forwardIdentity: true,
  connect: { label: "Reconnect", href: "/apps/connect?slug=linear" },
  disconnect: "/apps/app_disconnect?slug=linear",
};

/** The proxied app's other half: headers-mode, so there is no OAuth dance to be connected
 *  by and no status word the header could say — and no Connect control either. */
const notionHeader: AppDetailHeader = {
  ...proxiedHeader,
  name: "Notion",
  slug: "notion",
  authMode: "headers",
  status: null,
  connect: null,
  disconnect: null,
};

/** The four §20 families one render carries: what the panes list, and what the rail counts. */
type AppCatalog = Pick<AppDetailProps, "tools" | "prompts" | "resources" | "templates">;

/**
 * The rail, DERIVED from the very props the panes beside it render — §13's shell rule
 * ("markers read from the same calls that render the panes, never a second query that
 * could disagree with them") holds for the preview only if the fixture derives them too.
 * A hand-typed count here would draw the one state the rule forbids, on the reference
 * a reviewer reads to judge every other page.
 */
function appRail(props: Omit<AppDetailProps, "rail">): AppRailEntry[] {
  const roleNames = Object.keys(props.roles);
  const marker: Record<AppDetailPane, string> = {
    tools: familyMarker(props.tools),
    prompts: familyMarker(props.prompts),
    // One marker, one pane, two lists: the Resources pane draws both tabs (§13).
    resources: familyMarker(props.resources, props.templates),
    roles: roleNames.length === 0 ? "none" : String(roleNames.length),
    overview: "",
    access: String(props.agents.length),
    // §2's reason, not a missing feature: nothing dials in to a proxied app, so it holds
    // no key and its entry dims like a family it does not advertise.
    token: props.header.kind === "proxy" ? DIMMED : String(props.tokens.length),
    danger: "",
  };
  const table: { pane: AppDetailPane; label: string; group: AppRailEntry["group"] }[] = [
    { pane: "tools", label: "Tools", group: "App" },
    { pane: "prompts", label: "Prompts", group: "App" },
    { pane: "resources", label: "Resources", group: "App" },
    { pane: "roles", label: "Roles", group: "App" },
    { pane: "overview", label: "Overview", group: "App" },
    { pane: "access", label: "Agents", group: "Access" },
    { pane: "token", label: "Token", group: "Access" },
    { pane: "danger", label: "Danger zone", group: null },
  ];
  const slug = props.header.slug;
  return table.map((entry) => ({
    ...entry,
    href: entry.pane === "tools" ? `/apps/${slug}` : `/apps/${slug}/${entry.pane}`,
    marker: marker[entry.pane],
  }));
}

/** Everything a pane render shares, so each fixture below says only what makes it that
 *  state — the paned page's own version of the `shell` helper above. `over` carries the
 *  three lists the rail counts, so a fixture that changes one changes its marker with it;
 *  anything the rail does not read (the Resources tab, a dialog, a reveal) is spread over
 *  the result at the call site. */
const appDetail = (
  header: AppDetailHeader,
  pane: AppDetailPane,
  catalog: AppCatalog,
  over: Partial<Pick<AppDetailProps, "roles" | "agents" | "tokens">> = {},
): AppDetailProps => {
  const props: Omit<AppDetailProps, "rail"> = {
    ...shell("apps"),
    csrfToken: CSRF,
    pane,
    header,
    tab: "resources",
    hubOrigin: "https://hub.example",
    // §20.3's canonical read shape, in both of its directions: `reader` carries three
    // families and prints the object, `crawler` is tools-only and prints a bare list.
    roles:
      header.kind === "tunnel"
        ? {}
        : {
            reader: { tools: ["issue_.*"], prompts: ["digest_.*"], resources: ["news://feed/*"] },
            crawler: ["jobfeed_.*"],
          },
    overview: {
      createdAt: ms("2026-08-12T09:00:00.000Z"),
      logBodies: header.kind === "tunnel",
      logBodiesIsDefault: true,
      redactedArgs: [],
      redactedResults: [],
    },
    // The board's two Agents rows, and the tunneled app's one live key. A proxied app
    // holds no key at all (§2).
    agents: appAgents,
    tokens: header.kind === "tunnel" ? [liveAppToken] : [],
    confirm: null,
    reveal: null,
    ...catalog,
    ...over,
  };
  return { ...props, rail: appRail(props) };
};

/** AppDetailPanes "Agents": the built-in `all` beside a declared role, so both chip
 *  spellings — and the `built-in` marking — are drawn at once. */
const appAgents: AppAgentRow[] = [
  {
    slug: "claude",
    description: "the main agent",
    chips: [{ role: "all", mode: "allow", builtin: true }],
  },
  {
    slug: "pi",
    description: "the home Raspberry Pi",
    chips: [{ role: "reader", mode: "approval", builtin: false }],
  },
];

const liveAppToken: AppTokenRow = {
  id: "tok_9f3k",
  prefix: "pmcp_app_9f3k",
  createdAt: ms("2026-08-12T09:00:00.000Z"),
  lastUsedAt: ms(NOW),
};

const UNDECLARED = { state: "undeclared" } as const;
const UNREAD = { state: "unread" } as const;

/** The tools-only catalog: the tunneled app's own, and what every fixture below whose
 *  subject is elsewhere (grants, keys, the danger zone) carries unchanged — the rail
 *  beside those panes is still counted from it. */
const TUNNEL_CATALOG = {
  tools: { state: "listed", rows: mcpToolsCatalog },
  prompts: UNDECLARED,
  resources: UNDECLARED,
  templates: UNDECLARED,
} as const;

/** Nothing could be listed at all — the state whose every App-group marker is blank. */
const UNREAD_CATALOG = {
  tools: UNREAD,
  prompts: UNREAD,
  resources: UNREAD,
  templates: UNREAD,
} as const;

const linearPrompts: AppPromptRow[] = [
  {
    name: "digest_daily",
    aggregated: "linear_digest_daily",
    description: "Summarize today's issues.",
    args: [{ name: "day", description: "Which day.", required: true }],
    reach: [{ agent: "claude", mode: "allow", roles: ["reader"] }],
    redacted: ["audience"],
  },
  {
    name: "weekly_note",
    aggregated: "linear_weekly_note",
    description: "Draft the weekly note.",
    args: [],
    reach: [],
    redacted: [],
  },
];

const linearResources: AppResourceRow[] = [
  {
    uri: "news://feed/latest",
    name: "Latest headlines",
    mimeType: "text/plain",
    reach: [{ agent: "claude", mode: "allow", roles: ["reader"] }],
  },
  { uri: "news://sources", name: "Configured sources", mimeType: "application/json", reach: [] },
];

const linearTemplates: AppResourceRow[] = [
  {
    uri: "news://feed/{id}",
    name: "One story by id",
    mimeType: "text/plain",
    reach: [{ agent: "claude", mode: "allow", roles: ["reader"] }],
  },
];

/** TUNNEL_CATALOG's counterpart for the proxied app: all four families listed, which is
 *  what every `linear` fixture below carries — the rail's App-group markers are the
 *  lengths of these very lists, so a fixture that spelled them per pane could disagree
 *  with itself between panes. */
const PROXY_CATALOG = {
  tools: { state: "listed", rows: mcpToolsCatalog },
  prompts: { state: "listed", rows: linearPrompts },
  resources: { state: "listed", rows: linearResources },
  templates: { state: "listed", rows: linearTemplates },
} as const;

const appDetailFixtures = {
  /** AppDetail.dc.html: a tunneled app online, Tools listed, prompts and resources dimmed. */
  default: appDetail(tunnelHeader, "tools", TUNNEL_CATALOG),

  /** The same app offline and never re-listed — the header's other tunneled state, with
   *  the DO's cached catalog still listed under its own count (§13). */
  offline: appDetail(
    { ...tunnelHeader, status: "offline", lastSeen: ms("2026-08-24T13:20:00.000Z") },
    "tools",
    TUNNEL_CATALOG,
  ),

  /** Provisioned and never connected: no catalog, no last seen, §20.5's empty state. */
  /** §13 (2026-09-03): never connected means no catalog at all — every family dims and the
   *  pane says so, rather than an empty tools list that would claim a declaration. */
  neverConnected: appDetail(
    { ...tunnelHeader, name: "Weather bot", slug: "weather", status: "offline", lastSeen: null },
    "tools",
    {
      tools: { state: "unconnected" },
      prompts: { state: "unconnected" },
      resources: { state: "unconnected" },
      templates: { state: "unconnected" },
    },
  ),

  /** AppDetailStates "ARCHIVED": refuses connections, keeps its retained catalog. */
  archived: appDetail(
    { ...tunnelHeader, archived: true, status: "archived" },
    "tools",
    TUNNEL_CATALOG,
  ),

  /** AppDetailStates "PROXIED · OAUTH": the upstream card, connected. */
  proxied: appDetail(proxiedHeader, "tools", PROXY_CATALOG),

  /** AppDetailStates "NEEDS RECONNECT": the listing failed, so every App-group marker is
   *  BLANK — never `—`, which would say the app advertises none, and never 0. */
  needsReconnect: appDetail(
    { ...proxiedHeader, name: "GitHub", slug: "github", status: "needs reconnect", connect: { label: "Reconnect", href: "/apps/connect?slug=github" } },
    "tools",
    UNREAD_CATALOG,
  ),

  /** The other half of §13's "unreachable or needs-reconnect": a headers-mode app the hub
   *  could not reach at all. Same blank markers, and a state SAID rather than an empty
   *  card — but no Reconnect, because no credential exists to have failed. */
  unreachable: appDetail(notionHeader, "tools", UNREAD_CATALOG),

  /** A proxied app whose owner declared tools only (§20.2's "absent ≡ [tools]") — the
   *  tools-only catalog carried by the other kind, so a dimmed entry is drawn on both. */
  dimmedProxy: appDetail(notionHeader, "prompts", TUNNEL_CATALOG),

  /** AppDetailPanes "Prompts" and "Resources", at their own URLs. */
  prompts: appDetail(proxiedHeader, "prompts", PROXY_CATALOG),

  /** The dimmed entry's own pane for a TUNNELED app — the other half of `dimmedProxy`,
   *  and the only state that draws §13's two §20.5 sentences (the kind that says "declare
   *  it with your SDK", where the proxied one says "add it to `capabilities`"). */
  promptsUndeclared: appDetail(tunnelHeader, "prompts", TUNNEL_CATALOG),

  resources: appDetail(proxiedHeader, "resources", PROXY_CATALOG),

  templates: {
    ...appDetail(proxiedHeader, "resources", PROXY_CATALOG),
    tab: "templates",
  },

  /** AppDetailPanes "Roles", proxied: the config sentence, and the canonical read shape
   *  in both of its directions (one per-family object, one bare list). */
  roles: appDetail(proxiedHeader, "roles", PROXY_CATALOG),

  /** The tunneled half of the same pane: §2's trust-boundary line, which a proxied app
   *  never draws because nobody declared its roles about itself. */
  rolesTunneled: appDetail(tunnelHeader, "roles", TUNNEL_CATALOG, {
    roles: { reader: ["get_.*"] },
  }),

  /** The board's own Roles drawing: an app that declared none, and the built-in `all`
   *  fallback that stands in for them. */
  rolesEmpty: appDetail(tunnelHeader, "roles", TUNNEL_CATALOG),

  /** AppDetailPanes "Overview", tunneled: body logging at its kind's §15 default and no
   *  redaction configured, which is the state the board draws. */
  overview: appDetail(tunnelHeader, "overview", TUNNEL_CATALOG),

  /** The proxied Overview: three more rows (endpoint, auth, forward identity), the other
   *  kind's default, and configured redaction paths in place of `none`. */
  overviewProxied: {
    ...appDetail(proxiedHeader, "overview", PROXY_CATALOG),
    overview: {
      createdAt: ms("2026-08-12T09:00:00.000Z"),
      logBodies: true,
      // The owner turned it ON against the proxied default, so no default is named.
      logBodiesIsDefault: false,
      redactedArgs: ["payload.key", "audience"],
      redactedResults: ["out.token"],
    },
  },

  /** §15's third body-logging arm: a proxied app left at its own default, where the value
   *  names that default. `overview` above draws the tunneled default and `overviewProxied`
   *  the explicitly-set value, which names no default because naming one would be false. */
  overviewProxiedDefault: appDetail(proxiedHeader, "overview", PROXY_CATALOG),

  /** AppDetailPanes "Agents": both chip spellings, and no Edit grants control anywhere —
   *  the board draws one three times and §13 removes it until the editor lands. */
  agents: appDetail(tunnelHeader, "access", TUNNEL_CATALOG),

  /** The same pane with nothing granted yet: the marker reads 0 and the footer still says
   *  where grants are edited, because that is true of `grant_set` regardless. */
  agentsEmpty: appDetail(tunnelHeader, "access", TUNNEL_CATALOG, { agents: [] }),

  /** AppDetailPanes "Token": one live key, Revoke behind its dialog, Issue beside it. */
  token: appDetail(tunnelHeader, "token", TUNNEL_CATALOG),

  /** The state only the Issue POST can produce: the plaintext, in the one response that
   *  will ever carry it (§4/§15). */
  tokenRevealed: {
    ...appDetail(tunnelHeader, "token", TUNNEL_CATALOG, {
      tokens: [liveAppToken, { id: "tok_2b8x", prefix: "pmcp_app_2b8x", createdAt: ms(NOW), lastUsedAt: null }],
    }),
    reveal: "pmcp_app_2b8xQv7Ld0Rk4Ht1Zc6Ns9Wj3Fy",
  },

  /** The proxied half: the dimmed entry's own pane, which explains §2 and draws no
   *  control at all — `token_issue` refuses `kind: "app"` on this app for that reason. */
  tokenProxied: appDetail(proxiedHeader, "token", PROXY_CATALOG),

  /** AppDetailPanes "Danger zone": Archive and Delete, each a link to its own dialog. */
  danger: appDetail(tunnelHeader, "danger", TUNNEL_CATALOG),

  /** The archived app's danger zone: the banner above it, and Unarchive in Archive's
   *  place — the one control here that destroys nothing and needs no dialog. */
  dangerArchived: appDetail(
    { ...tunnelHeader, archived: true, status: "archived" },
    "danger",
    TUNNEL_CATALOG,
  ),

  /** Dialogs.dc.html, this page's three: the Token pane's Revoke, and the danger zone's
   *  Archive and Delete, each rendered open on the pane that owns it. */
  confirmRevokeToken: {
    ...appDetail(tunnelHeader, "token", TUNNEL_CATALOG),
    confirm: { kind: "revoke-token", id: liveAppToken.id, prefix: liveAppToken.prefix },
  },

  confirmArchive: {
    ...appDetail(tunnelHeader, "danger", TUNNEL_CATALOG),
    confirm: { kind: "archive" },
  },

  confirmDelete: {
    ...appDetail(tunnelHeader, "danger", TUNNEL_CATALOG),
    confirm: { kind: "delete" },
  },
} satisfies Record<string, AppDetailProps>;

/* ------------------------------------------------------------------ *
 * /apps/new
 * ------------------------------------------------------------------ */

/** Obviously fake, and shaped like the real thing so the layout is honest. */
const FAKE_APP_TOKEN = "pmcp_app_FAKE0000000000000000000000000000000000";

const appNew = {
  /** The artboard's state: a proxied app about to be OAuth-connected. */
  default: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: {
        kind: "proxy",
        name: "Linear",
        slug: "linear",
        endpoint: "https://mcp.linear.app/mcp",
        authMode: "oauth",
      },
      errors: {},
    },
  },

  /** AppNewStates "TUNNELED": no endpoint, no auth — the token comes after. */
  tunneled: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: {
        kind: "tunnel",
        name: "News MCP",
        slug: "news",
        endpoint: "",
        authMode: "headers",
      },
      errors: {},
    },
  },

  /** An untouched form — the first thing "Add app" shows. */
  blank: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: { kind: "tunnel", name: "", slug: "", endpoint: "", authMode: "headers" },
      errors: {},
    },
  },

  /** AppNewStates "SLUG ERROR": the reserved builtin, refused uniformly (§8). The sentence
   *  is the OP's own, as the page yields it (§13) — not copy this file invents. */
  slugReserved: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: { kind: "tunnel", name: "PMCP", slug: "pmcp", endpoint: "", authMode: "headers" },
      errors: { slug: `The slug "pmcp" is reserved for the builtin admin app.` },
    },
  },

  /** Charset rejection — slugs are [a-z0-9-], no underscore (§2). The sentence is the one
   *  the schema's own coercion produces, which is what refuses this slug first. */
  slugInvalid: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: {
        kind: "tunnel",
        name: "News Feed",
        slug: "News_Feed",
        endpoint: "",
        authMode: "headers",
      },
      errors: { slug: "Is not a valid slug." },
    },
  },

  /** AppNewProxiedStates: several violations at once, one of them naming no control of
   *  the form (`roles`) and therefore drawn as the whole-form message. No `name` key —
   *  §8 defaults a blank Name to the slug, so no refusal can name it. */
  errors: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: {
        kind: "proxy",
        name: "",
        slug: "notion",
        endpoint: "mcp.notion.com",
        authMode: "headers",
      },
      errors: {
        slug: "Already exists in this namespace.",
        endpoint: "Must be an https:// URL (http:// only for localhost).",
        form: `Role name "all" is reserved.`,
      },
    },
  },

  /** AppNewProxiedStates "CONNECTING": the `auth: oauth` receipt — the app exists and the
   *  owner clicks through to the provider (§18 decision 30: a link, never an auto-open). */
  connecting: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "connecting",
      slug: "linear",
      name: "Linear",
      url: "https://linear.app/oauth/authorize?client_id=https%3A%2F%2Fmcp.example.com%2Fclient&state=FAKE0000-state",
    },
  },

  /** AppNewStates "TOKEN REVEAL": the one render that holds the token. */
  tokenReveal: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "created",
      slug: "news",
      name: "News MCP",
      token: FAKE_APP_TOKEN,
    },
  },

  /** A proxied app has no token — the same receipt, one card lighter. */
  createdProxy: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: { kind: "created", slug: "notion", name: "Notion", token: null },
  },

  /** Edge: the slug helper line has to wrap around a very long endpoint. */
  longValues: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: {
        kind: "proxy",
        name: "Internal observability and incident response toolkit (staging mirror)",
        slug: "internal-observability-and-incident-response-toolkit",
        endpoint:
          "https://mcp.internal.example.com/observability/incident-response/v2/streamable-http?tenant=staging-mirror",
        authMode: "oauth",
      },
      errors: {},
    },
  },
} satisfies Record<string, AppNewProps>;

/* ------------------------------------------------------------------ *
 * /approvals and /approvals/<id>
 * ------------------------------------------------------------------ */

const pendingSetScene = {
  id: "apr_8f2k",
  agentSlug: "claude",
  appSlug: "home",
  tool: "set_scene",
  args: { scene: "movie_night" },
  status: "pending",
  createdAt: "2026-08-24T14:29:55.000Z",
  decidedAt: null,
  expiresAt: "2026-08-24T15:29:55.000Z",
} satisfies ApprovalRow;

const pendingCreatePage = {
  id: "apr_3d7m",
  agentSlug: "cron",
  appSlug: "notion",
  tool: "create_page",
  args: {
    title: "Weekly report",
    parent: "Reports",
    // Config-declared redaction path (§9's redact: create_page → credentials.token).
    credentials: { token: "‹redacted›" },
  },
  status: "pending",
  createdAt: "2026-08-24T14:12:31.000Z",
  decidedAt: null,
  expiresAt: "2026-08-24T15:12:31.000Z",
} satisfies ApprovalRow;

const approvalHistory: ApprovalRow[] = [
  {
    id: "apr_7c1a",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "reading" },
    status: "approved",
    createdAt: "2026-08-24T14:26:40.000Z",
    decidedAt: "2026-08-24T14:31:02.000Z",
    expiresAt: "2026-08-24T15:26:40.000Z",
  },
  {
    id: "apr_5b9e",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "away" },
    status: "used",
    createdAt: "2026-08-24T13:18:22.000Z",
    decidedAt: "2026-08-24T13:20:05.000Z",
    expiresAt: "2026-08-24T14:18:22.000Z",
  },
  {
    id: "apr_2f4d",
    agentSlug: "cron",
    appSlug: "notion",
    tool: "create_page",
    args: { title: "Nightly digest", parent: "Inbox" },
    status: "rejected",
    createdAt: "2026-08-24T09:10:02.000Z",
    decidedAt: "2026-08-24T09:12:44.000Z",
    expiresAt: "2026-08-24T10:10:02.000Z",
  },
  {
    id: "apr_9a3b",
    agentSlug: "claude",
    appSlug: "home",
    tool: "unlock_door",
    args: { door: "front", duration_s: 30 },
    status: "rejected",
    createdAt: "2026-08-23T22:38:51.000Z",
    decidedAt: "2026-08-23T22:40:18.000Z",
    expiresAt: "2026-08-23T23:38:51.000Z",
  },
  {
    id: "apr_4e8c",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "dinner" },
    status: "used",
    createdAt: "2026-08-23T18:03:12.000Z",
    decidedAt: "2026-08-23T18:05:51.000Z",
    expiresAt: "2026-08-23T19:03:12.000Z",
  },
  {
    id: "apr_1d6f",
    agentSlug: "cron",
    appSlug: "news",
    tool: "purge_cache",
    args: { older_than: "24h" },
    status: "expired",
    createdAt: "2026-08-22T11:30:09.000Z",
    decidedAt: null,
    expiresAt: "2026-08-22T12:30:09.000Z",
  },
];

/** Edge: an argument object nobody sized a <pre> for, secrets already masked. */
const bulkyArgs: Record<string, unknown> = {
  operation: "bulk_update",
  dry_run: false,
  filter: {
    workspace: "engineering",
    updated_after: "2026-08-01T00:00:00.000Z",
    labels: ["incident", "postmortem", "follow-up", "sev2", "customer-visible"],
  },
  updates: Array.from({ length: 12 }, (_, i) => ({
    page_id: `page_${(i + 1).toString().padStart(4, "0")}`,
    title: `Postmortem ${i + 1}: sustained upstream latency in the eu-west region`,
    properties: { status: "published", owner: "agent:cron", reviewed: i % 2 === 0 },
  })),
  credentials: { token: "‹redacted›", refresh_token: "‹redacted›" },
  notify: { channel: "#eng-incidents", mention: ["@oncall"], webhook_secret: "‹redacted›" },
};

const approvals = {
  /** Two waiting decisions and a week of history — the artboard's state. */
  default: {
    ...shell("approvals"),
    csrfToken: CSRF,
    pending: [pendingSetScene, pendingCreatePage],
    history: approvalHistory,
    historyLimit: 25,
    hasMoreHistory: true,
    vapidPublicKey: "BFAKE0000pmcpFAKEvapidPUBLICkeyFAKE0000pmcpFAKEvapid0000",
  },

  /** EmptyStates "Approvals — no pending": history only, badge at zero. */
  noPending: {
    ...shell("approvals", 0),
    csrfToken: CSRF,
    pending: [],
    history: approvalHistory,
    historyLimit: 25,
    hasMoreHistory: false,
    vapidPublicKey: "BFAKE0000pmcpFAKEvapidPUBLICkeyFAKE0000pmcpFAKEvapid0000",
  },

  /** EmptyStates, both halves: nothing has ever been gated here. */
  empty: {
    ...shell("approvals", 0),
    csrfToken: CSRF,
    pending: [],
    history: [],
    historyLimit: 25,
    hasMoreHistory: false,
    vapidPublicKey: "BFAKE0000pmcpFAKEvapidPUBLICkeyFAKE0000pmcpFAKEvapid0000",
  },

  /** A decision that raced the agent's retry and lost. */
  decideFailed: {
    ...shell("approvals", 1, {
      tone: "warning",
      title: "That request is no longer pending",
      message: "It expired at 15:12:31. The agent's next attempt opens a fresh one.",
    }),
    csrfToken: CSRF,
    pending: [pendingSetScene],
    history: [
      { ...pendingCreatePage, status: "expired", decidedAt: null },
      ...approvalHistory,
    ],
    historyLimit: 25,
    hasMoreHistory: true,
    vapidPublicKey: "BFAKE0000pmcpFAKEvapidPUBLICkeyFAKE0000pmcpFAKEvapid0000",
  },

  /** Edge: a pending card carrying a very large argument object. */
  bulkyArgs: {
    ...shell("approvals", 1),
    csrfToken: CSRF,
    pending: [
      {
        ...pendingCreatePage,
        id: "apr_6h4p",
        tool: "bulk_update_pages",
        args: bulkyArgs,
      },
    ],
    history: approvalHistory,
    historyLimit: 25,
    hasMoreHistory: true,
    vapidPublicKey: "BFAKE0000pmcpFAKEvapidPUBLICkeyFAKE0000pmcpFAKEvapid0000",
  },
} satisfies Record<string, ApprovalsProps>;

const approvalDetail = {
  /** The link a -32003 hands the owner: decidable, 43 minutes left. */
  default: {
    now: NOW,
    csrfToken: CSRF,
    approval: pendingSetScene,
  },

  /** ApprovalStates "APPROVED — AWAITING RETRY": a pass nobody has spent yet. */
  approved: {
    now: NOW,
    csrfToken: CSRF,
    approval: {
      ...pendingSetScene,
      status: "approved",
      decidedAt: "2026-08-24T14:44:10.000Z",
    },
  },

  /** Spent by the agent's identical retry — terminal (§7). */
  used: {
    now: NOW,
    csrfToken: CSRF,
    approval: {
      ...pendingSetScene,
      status: "used",
      decidedAt: "2026-08-24T14:45:37.000Z",
    },
  },

  /** Refused: the next attempt opens a fresh request. */
  rejected: {
    now: NOW,
    csrfToken: CSRF,
    approval: {
      ...pendingSetScene,
      id: "apr_9a3b",
      tool: "unlock_door",
      args: { door: "front", duration_s: 30 },
      status: "rejected",
      decidedAt: "2026-08-24T14:40:12.000Z",
    },
  },

  /** ApprovalStates "EXPIRED": undecided for an hour, reported expired on read. */
  expired: {
    now: NOW,
    csrfToken: CSRF,
    approval: {
      ...pendingSetScene,
      status: "expired",
      createdAt: "2026-08-24T13:29:55.000Z",
      expiresAt: "2026-08-24T14:29:55.000Z",
      decidedAt: null,
    },
  },

  /** Edge: the arguments block dwarfs the decision it belongs to. */
  bulkyArgs: {
    now: NOW,
    csrfToken: CSRF,
    approval: {
      ...pendingCreatePage,
      id: "apr_6h4p",
      tool: "bulk_update_pages",
      args: bulkyArgs,
    },
  },
} satisfies Record<string, ApprovalDetailProps>;

/* ------------------------------------------------------------------ *
 * /audit
 * ------------------------------------------------------------------ */

const AUDIT_SINCE = ms("2026-08-18T00:00:00.000Z");
const AUDIT_UNTIL = ms(NOW);

/** The loader's own shape over a window — 24 buckets of `ceil(span / 24)`, the peak the
 *  highlighted bar — so a fixture's histogram cannot disagree with the window its filters
 *  declare (orphan note 85). Counts past 24 are dropped; missing ones read 0. */
function histogramFor(since: number, until: number, counts: number[]): AuditHistogram {
  const bucketMs = Math.ceil((until - since) / 24);
  const buckets = Array.from({ length: 24 }, (_, i) => ({
    start: new Date(since + i * bucketMs).toISOString(),
    count: counts[i] ?? 0,
  }));
  return { bucketMs, buckets, peak: Math.max(0, ...buckets.map((b) => b.count)) };
}

/** The visible week's bars, the 18th bucket the peak. */
const WEEK_COUNTS = [20, 55, 43, 27, 17, 57, 69, 35, 24, 64, 51, 40, 14, 45, 62, 32, 26, 119, 83, 47, 19, 69, 56, 31];

const auditRows: AuditEventRow[] = [
  {
    id: 41287,
    ts: ms("2026-08-24T14:32:07.000Z"),
    principal: "agent:claude",
    event: "tools/call",
    app: "news",
    tool: "get_news",
    outcome: "ok",
    durationMs: 340,
    client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
    args: { topic: "semiconductors", limit: 5 },
    result: {
      structuredContent: { items: 5, cached: false, next_cursor: "cur_8823" },
      content: [{ stub: "blob", contentType: "text/plain", bytes: 2841 }],
    },
  },
  {
    id: 41286,
    ts: ms("2026-08-24T14:31:48.000Z"),
    principal: "agent:claude",
    event: "tools/call",
    app: "notion",
    tool: "create_page",
    outcome: "ok",
    durationMs: 1204,
    client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
    // Proxied app with log_bodies opted in (§9) — config paths do the masking.
    args: { title: "Weekly report", parent: "Reports", credentials: { token: "‹redacted›" } },
    result: { structuredContent: { page_id: "page_0091", url: "https://notion.so/page_0091" } },
  },
  {
    id: 41285,
    ts: ms("2026-08-24T14:30:12.000Z"),
    principal: "user:ahrzb",
    event: "admin.grant_set",
    app: "notion",
    outcome: "ok",
    detail: { agent: "claude", roles: ["editor"], removed: ["reader"] },
  },
  {
    id: 41284,
    ts: ms("2026-08-24T14:29:55.000Z"),
    principal: "agent:claude",
    event: "approval.requested",
    app: "home",
    tool: "set_scene",
    outcome: "-32003",
    client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
    detail: { approval: "apr_8f2k", status: "pending", expires_in: "60m" },
  },
  {
    id: 41283,
    ts: ms("2026-08-24T14:18:03.000Z"),
    principal: "app:news",
    event: "connect.register",
    app: "news",
    outcome: "ok",
    detail: { roles: ["reader", "admin"], client_version: "pmcp-client-py 0.4.1" },
  },
  {
    id: 41282,
    ts: ms("2026-08-24T14:17:59.000Z"),
    principal: "app:news",
    event: "connect.replaced",
    app: "news",
    outcome: "ok",
    detail: { reason: "newer connection accepted", close_code: 4000 },
  },
  {
    id: 41281,
    ts: ms("2026-08-24T13:58:31.000Z"),
    principal: "agent:claude",
    event: "tools/call",
    app: "home",
    tool: "lights_on",
    outcome: "-32002",
    durationMs: 8,
    client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
    // A refusal never carries bodies (§15) — the detail names the class, and the panel
    // says why there is nothing else to show (§13).
    detail: { reason: "app archived" },
    noBodies: "refused",
  },
  {
    id: 41280,
    ts: ms("2026-08-24T13:44:10.000Z"),
    principal: "user:ahrzb",
    event: "approval.approved",
    app: "home",
    tool: "set_scene",
    outcome: "ok",
    detail: { approval: "apr_7c1a" },
  },
  {
    id: 41279,
    ts: ms("2026-08-24T13:20:05.000Z"),
    principal: "user:ahrzb",
    event: "auth.device_approved",
    outcome: "ok",
    detail: { ip: "203.0.113.42", client: "pmcp CLI on Windows" },
  },
  {
    id: 41278,
    ts: ms("2026-08-24T12:59:47.000Z"),
    principal: "agent:cron",
    event: "tools/call",
    app: "news",
    tool: "search_news",
    outcome: "-32001",
    durationMs: 4,
    client: { name: "pmcp-cli", version: "0.9.2" },
    detail: { reason: "tool not permitted" },
    noBodies: "refused",
  },
  {
    id: 41277,
    ts: ms("2026-08-24T12:41:33.000Z"),
    principal: "agent:claude",
    event: "tools/call",
    app: "notion",
    tool: "search",
    outcome: "ok",
    durationMs: 890,
    client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
    // Dispatched, and nothing in the body columns: this app's logging is on today (41286
    // records bodies), so the row predates the switch (§13's third sentence).
    noBodies: "unrecorded",
  },
  {
    id: 41276,
    ts: ms("2026-08-24T12:02:19.000Z"),
    principal: "user:ahrzb",
    event: "admin.app_archive",
    app: "home",
    outcome: "ok",
    detail: { slug: "home", severed: true },
  },
  {
    id: 41275,
    ts: ms("2026-08-24T11:47:02.000Z"),
    principal: "agent:claude",
    event: "tools/call",
    app: "news",
    tool: "get_news",
    outcome: "ok",
    durationMs: 290,
    client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
    noBodies: "unrecorded",
  },
];

const auditOptions = {
  principals: ["agent:claude", "agent:cron", "app:news", "app:home", "user:ahrzb", HUB_PRINCIPAL],
  apps: ["news", "notion", "linear", "github", "slack", "home", "pmcp"],
  events: [
    "tools/call",
    "approval.requested",
    "approval.approved",
    "approval.rejected",
    "approval.expired",
    "connect.register",
    "connect.replaced",
    "connect.roles_widened",
    "auth.login",
    "auth.device_approved",
    "admin.app_create",
    "admin.app_archive",
    "admin.grant_set",
    "admin.token_issue",
    "upstream.oauth_connected",
    "upstream.oauth_refresh_failed",
    "cron.swept",
  ],
};

/**
 * The two boards that exist to show ONE panel — §13's sentence for a call row with no
 * bodies. Everything but the row is the session board's 24h window, so what differs
 * between them is exactly what the sentence is about.
 */
function noBodiesBoard(row: AuditEventRow, denied: 0 | 1): AuditProps {
  const since = ms("2026-08-23T14:47:00.000Z");
  return {
    ...shell("audit"),
    notice: null,
    filters: { app: row.app, range: "24h", since, until: AUDIT_UNTIL, limit: 50, offset: 0 },
    options: auditOptions,
    rows: [row],
    paging: { offset: 0, limit: 50, total: 1 },
    stats: {
      events: 1,
      eventsDeltaPct: null,
      toolCalls: 1,
      denied,
      medianDurationMs: row.durationMs ?? null,
      p95DurationMs: row.durationMs ?? null,
    },
    histogram: histogramFor(since, AUDIT_UNTIL, Array.from({ length: 24 }, (_, i) => (i === 23 ? 1 : 0))),
    expandedId: row.id,
    retentionDays: 7,
    scanCeiling: null,
  };
}

const audit = {
  /** The artboard: a TRUE last 7 days (the span `rangeOf` calls "7d", so the segment is
   *  current and the date inputs empty), first page, one row's detail open. */
  default: {
    ...shell("audit"),
    notice: null,
    filters: {
      range: "7d",
      since: AUDIT_UNTIL - 7 * 24 * HOUR,
      until: AUDIT_UNTIL,
      limit: 50,
      offset: 0,
    },
    options: auditOptions,
    rows: auditRows,
    paging: { offset: 0, limit: 50, total: 1284 },
    stats: {
      events: 1284,
      eventsDeltaPct: 12,
      toolCalls: 1131,
      denied: 23,
      medianDurationMs: 240,
      p95DurationMs: 1900,
    },
    histogram: histogramFor(AUDIT_UNTIL - 7 * 24 * HOUR, AUDIT_UNTIL, WEEK_COUNTS),
    expandedId: 41284,
    retentionDays: 7,
    // The one fixture that shows the label: total (1284) past AUDIT_SCAN_ROWS (§13/G22).
    scanCeiling: 1000,
  },

  /** Deep in the result set: both pager arrows live, nothing expanded — and the CUSTOM
   *  window (6 d 14 h 47 m, no preset's span): four unselected segments, both date inputs
   *  filled, the events tile reading "vs previous period". */
  middlePage: {
    ...shell("audit"),
    notice: null,
    filters: {
      range: "custom",
      since: AUDIT_SINCE,
      until: AUDIT_UNTIL,
      limit: 50,
      offset: 250,
    },
    options: auditOptions,
    rows: auditRows,
    paging: { offset: 250, limit: 50, total: 1284 },
    stats: {
      events: 1284,
      eventsDeltaPct: 12,
      toolCalls: 1131,
      denied: 23,
      medianDurationMs: 240,
      p95DurationMs: 1900,
    },
    histogram: histogramFor(AUDIT_SINCE, AUDIT_UNTIL, WEEK_COUNTS),
    expandedId: null,
    retentionDays: 7,
    // The same 1,284-row window as `default`, so the same ceiling label (§13).
    scanCeiling: 1000,
  },

  /** A session link followed (?session=…): one agent conversation, narrow window. */
  filteredBySession: {
    ...shell("audit"),
    notice: null,
    filters: {
      session: "a3f9c2d1",
      range: "24h",
      since: ms("2026-08-23T14:47:00.000Z"),
      until: AUDIT_UNTIL,
      limit: 50,
      offset: 0,
    },
    options: auditOptions,
    rows: auditRows.filter((row) => row.client?.sessionId === "a3f9c2d1"),
    paging: { offset: 0, limit: 50, total: 7 },
    stats: {
      events: 7,
      eventsDeltaPct: null,
      toolCalls: 5,
      denied: 2,
      medianDurationMs: 340,
      p95DurationMs: 1204,
    },
    // The seven session events, all in the last few hours of the 24h window.
    histogram: histogramFor(
      ms("2026-08-23T14:47:00.000Z"),
      AUDIT_UNTIL,
      Array.from({ length: 24 }, (_, i) => (i === 22 ? 2 : [13, 16, 18, 21, 23].includes(i) ? 1 : 0)),
    ),
    expandedId: null,
    retentionDays: 7,
    scanCeiling: null,
  },

  /** EmptyStates "Audit — no results": filters narrower than the ledger. */
  empty: {
    ...shell("audit", 0),
    notice: null,
    filters: {
      principal: "agent:cron",
      app: "linear",
      tool: "create_issue",
      range: "1h",
      since: ms("2026-08-24T13:47:00.000Z"),
      until: AUDIT_UNTIL,
      limit: 50,
      offset: 0,
    },
    options: auditOptions,
    rows: [],
    paging: { offset: 0, limit: 50, total: 0 },
    stats: {
      events: 0,
      eventsDeltaPct: null,
      toolCalls: 0,
      denied: 0,
      medianDurationMs: null,
      p95DurationMs: null,
    },
    // What the loader computes for a 1h window with nothing in it: no bars, the bucket
    // size still derived (the caption describes the window, not the data).
    histogram: { bucketMs: 150_000, buckets: [], peak: 0 },
    expandedId: null,
    retentionDays: 7,
    scanCeiling: null,
  },

  /**
   * Edge: bodies at the hygiene limits (§15) — an image result stubbed by type
   * and size, an over-cap argument body swapped whole for an `oversize` stub,
   * and a tool name long enough to fight its column.
   */
  bodyStubs: {
    ...shell("audit"),
    notice: null,
    filters: {
      app: "news",
      range: "24h",
      since: ms("2026-08-23T14:47:00.000Z"),
      until: AUDIT_UNTIL,
      limit: 50,
      offset: 0,
    },
    options: auditOptions,
    rows: [
      {
        id: 41290,
        ts: ms("2026-08-24T14:40:00.000Z"),
        principal: "agent:claude",
        event: "tools/call",
        app: "news",
        tool: "render_front_page_screenshot_at_full_resolution",
        outcome: "ok",
        durationMs: 4820,
        client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
        // Both size units in the one open panel: an over-cap argument body just past the
        // 16 KiB cap reads in KB, the image block below it in MB (§13).
        args: { stub: "oversize", bytes: 20480 },
        result: {
          structuredContent: { rendered: true, source: "https://example.com/front-page" },
          content: [{ stub: "blob", contentType: "image/png", bytes: 4404019 }],
        },
      },
      {
        id: 41289,
        ts: ms("2026-08-24T14:36:12.000Z"),
        principal: "agent:cron",
        event: "tools/call",
        app: "news",
        tool: "ingest_corpus",
        outcome: "ok",
        durationMs: 12470,
        client: { name: "pmcp-cli", version: "0.9.2" },
        // Whole body over AUDIT_BODY_CAP_BYTES — replaced, never truncated (§15).
        args: { stub: "oversize", bytes: 2202009 },
        result: { structuredContent: { documents: 8213, skipped: 4 } },
      },
      {
        id: 41288,
        ts: ms("2026-08-24T14:33:41.000Z"),
        principal: "app:news",
        event: "connect.roles_widened",
        app: "news",
        outcome: "ok",
        detail: { roles: ["reader"], added: ["search_.*", "get_.*"] },
      },
      ...auditRows,
    ],
    paging: { offset: 0, limit: 50, total: 16 },
    stats: {
      events: 16,
      eventsDeltaPct: -4,
      toolCalls: 9,
      denied: 2,
      medianDurationMs: 340,
      p95DurationMs: 12470,
    },
    histogram: histogramFor(ms("2026-08-23T14:47:00.000Z"), AUDIT_UNTIL, WEEK_COUNTS),
    expandedId: 41290,
    retentionDays: 7,
    scanCeiling: null,
  },

  /** §13's first no-bodies sentence: a dispatched call on a PROXIED app, whose
   *  `log_bodies` is off by §15's default — the panel says so beside the client line. */
  bodiesOff: noBodiesBoard(
    {
      id: 41292,
      ts: ms("2026-08-24T14:28:41.000Z"),
      principal: "agent:claude",
      event: "tools/call",
      app: "linear",
      tool: "create_issue",
      outcome: "ok",
      durationMs: 612,
      client: { name: "claude-code", version: "2.1.37", sessionId: "a3f9c2d1" },
      noBodies: "off",
    },
    0,
  ),

  /** §13's second: a refusal, which never had bodies to record whatever the app's
   *  setting — and no `detail` either, so the sentence is the whole panel. */
  refused: noBodiesBoard(
    {
      id: 41293,
      ts: ms("2026-08-24T14:26:09.000Z"),
      principal: "agent:cron",
      event: "tools/call",
      app: "github",
      tool: "merge_pull_request",
      outcome: "-32001",
      durationMs: 5,
      client: { name: "pmcp-cli", version: "0.9.2", sessionId: "b7d1e4a8" },
      noBodies: "refused",
    },
    1,
  ),
} satisfies Record<string, AuditProps>;

/* ------------------------------------------------------------------ *
 * /oauth/consent (§19.5)
 * ------------------------------------------------------------------ */

/** The signed query the provider redirected the browser here with, echoed back
 *  byte-for-byte by the form — obviously fake, and never rebuilt from the fields below. */
const OAUTH_QUERY =
  "client_id=cli_FAKE0000a3f1&response_type=code&redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fcallback" +
  "&scope=mcp&resource=https%3A%2F%2Fmcp.example%2Fahrzb%2Fmcp&state=st_FAKE0000b7&code_challenge_method=S256";

const oauthConsent = {
  /** OauthConsent.dc.html: a known client, one scope, the full agent picker. */
  default: {
    now: NOW,
    csrfToken: CSRF,
    oauthQuery: OAUTH_QUERY,
    clientName: "Claude",
    clientSelfRegistered: false,
    redirectOrigin: "https://claude.ai",
    scopes: ["mcp"],
    namespace: "ahrzb",
    agents: [
      { slug: "claude", name: "claude" },
      { slug: "pi", name: "pi" },
    ],
  },

  /** OauthConsentStates "SELF-REGISTERED CLIENT": §19.3's DCR marker beside a name
   *  nobody vouched for, and the refresh scope asked for alongside `mcp`. */
  selfRegistered: {
    now: NOW,
    csrfToken: CSRF,
    oauthQuery: OAUTH_QUERY,
    clientName: "Acme Agent",
    clientSelfRegistered: true,
    redirectOrigin: "https://agent.acme.dev",
    scopes: ["mcp", "offline_access"],
    namespace: "ahrzb",
    agents: [{ slug: "claude", name: "claude" }],
  },

  /** OauthConsentStates "NO AGENTS": the first-run path — consent is impossible until an
   *  agent exists, so Authorize is disabled and only Deny works (§19.5). */
  noAgents: {
    now: NOW,
    csrfToken: CSRF,
    oauthQuery: OAUTH_QUERY,
    clientName: "Claude",
    clientSelfRegistered: false,
    redirectOrigin: "https://claude.ai",
    scopes: ["mcp"],
    namespace: "ahrzb",
    agents: [],
  },

  /** The client that registered without a name: every string on the card is the client's
   *  own, so the one it never sent is the page's fallback rather than an empty line. */
  anonymousClient: {
    now: NOW,
    csrfToken: CSRF,
    oauthQuery: OAUTH_QUERY,
    clientName: null,
    clientSelfRegistered: true,
    redirectOrigin: "https://agent.acme.dev",
    scopes: ["mcp"],
    namespace: "ahrzb",
    agents: [{ slug: "claude", name: "claude" }],
  },
} satisfies Record<string, ConsentProps>;

/* ------------------------------------------------------------------ *
 * The registry
 * ------------------------------------------------------------------ */

/**
 * page → fixture name → props. The dev preview walks this generically (every
 * value is that page's Props by construction), and the keys are model.ts's
 * PageName set, so a page without fixtures cannot compile.
 */
/* ------------------------------------------------------------------ *
 * /agents, /agents/new, /agents/<slug> (the Agents / AgentDetail /
 * AgentDetailPanes / AgentDetailStates boards, 2026-09-16)
 * ------------------------------------------------------------------ */

const agentRows: AgentRow[] = [
  {
    slug: "claude",
    name: "Claude",
    description: "Claude sessions",
    createdAt: ms("2026-08-12T09:00:00.000Z"),
    access: { apps: 3, allowed: 3, askFirst: 2, dormant: 1 },
    tokens: { active: 1, lastUsedAt: ms("2026-08-24T12:47:00.000Z") },
  },
  {
    slug: "cron",
    name: "cron",
    description: "Scheduled jobs",
    createdAt: ms("2026-08-20T16:05:00.000Z"),
    access: { apps: 1, allowed: 1, askFirst: 0, dormant: 0 },
    tokens: { active: 1, lastUsedAt: null },
  },
  {
    slug: "pi",
    name: "pi",
    description: "Raspberry Pi runner",
    createdAt: ms("2026-09-01T08:00:00.000Z"),
    access: { apps: 0, allowed: 0, askFirst: 0, dormant: 0 },
    tokens: { active: 0, lastUsedAt: null },
  },
];

const agents = {
  /** The artboard: three agents — one rich, one narrow, one holding nothing at all. */
  default: { ...shell("agents"), csrfToken: CSRF, agents: agentRows, confirm: null },
  /** A fresh namespace: the empty state and its New agent control. */
  empty: { ...shell("agents", 0), csrfToken: CSRF, agents: [], confirm: null },
  /** Dialogs "Delete agent", opened on the list's own URL. */
  confirmDelete: {
    ...shell("agents"),
    csrfToken: CSRF,
    agents: agentRows,
    confirm: { kind: "delete-agent" as const, row: agentRows[0] as AgentRow },
  },
} satisfies Record<string, AgentsProps>;

const agentNew = {
  default: { ...shell("agents"), csrfToken: CSRF, form: { slug: "", name: "", description: "" }, errors: {} },
  /** A refused slug, the reason under the field. */
  refused: {
    ...shell("agents"),
    csrfToken: CSRF,
    form: { slug: "new", name: "", description: "" },
    errors: { slug: 'the slug "new" is reserved: /agents/new is a page' },
  },
} satisfies Record<string, AgentNewProps>;

/* ---------------------------- the agent page ---------------------------- */

/** The header every agent-page fixture shares — one row on every pane, so no pane
 *  contributes anything to it. */
const agentHeader = (): AgentHeader => ({
  slug: "claude",
  name: "Claude",
  description: "Claude sessions",
  createdAt: ms("2026-08-12T09:00:00.000Z"),
  tiles: { apps: 3, allowed: 3, askFirst: 2, dormant: 1 },
});

/** The rail as every pane draws it: three apps (one archived, one asking first), the
 *  grant step's count, and the agent's own three entries. `current` is per fixture. */
const agentRail = (current: string): AgentRailEntry[] => [
  {
    href: "/agents/claude/apps/news",
    label: "news",
    group: "Apps",
    current: current === "news",
    marker: "",
    warn: true,
    dim: false,
  },
  {
    href: "/agents/claude/apps/linear",
    label: "linear",
    group: "Apps",
    current: current === "linear",
    marker: "",
    warn: false,
    dim: false,
  },
  {
    href: "/agents/claude/apps/home",
    label: "home",
    group: "Apps",
    current: current === "home",
    marker: DIMMED,
    warn: false,
    dim: true,
  },
  {
    href: "/agents/claude/grant",
    label: "+ Grant another app…",
    group: "Apps",
    current: current === "grant",
    marker: "1",
    warn: false,
    dim: false,
  },
  {
    href: "/agents/claude/credentials",
    label: "Credentials",
    group: "Agent",
    current: current === "credentials",
    marker: "1 · 1",
    warn: false,
    dim: false,
  },
  {
    href: "/agents/claude/activity",
    label: "Activity",
    group: "Agent",
    current: current === "activity",
    marker: "2",
    warn: true,
    dim: false,
  },
  {
    href: "/agents/claude/danger",
    label: "Danger zone",
    group: null,
    current: current === "danger",
    marker: "",
    warn: false,
    dim: false,
  },
];

/** A row's control, spelled once: the field name is the page's own `e.<entry>`. */
const seg = (entry: string, value: GrantChoice, implied: RowControl["implied"] = null, by: string[] = []): RowControl => ({
  field: `e.${entry}`,
  value,
  implied,
  impliedBy: by,
});

const rolesGroup: AgentListGroup = {
  title: "Roles",
  count: "4",
  note: "declared by the app at connect",
  state: null,
  rows: [
    {
      kind: "role",
      entry: "reader",
      builtin: false,
      detail: "tools get_news, search_.* · prompts digest_.* · matches 5",
      sel: "role:reader",
      control: seg("reader", "allow"),
    },
    {
      kind: "role",
      entry: "admin",
      builtin: false,
      detail: "tools admin_.* · matches 3",
      sel: "role:admin",
      control: seg("admin", "approval"),
    },
    {
      kind: "role",
      entry: "publisher",
      builtin: false,
      detail: "tools publish, delete_feed · matches 2",
      sel: "role:publisher",
      control: seg("publisher", "none"),
    },
    {
      kind: "role",
      entry: "all",
      builtin: true,
      detail: "every tool, prompt and resource, present and future · matches 15",
      sel: "role:all",
      control: seg("all", "none"),
    },
  ],
};

const toolsGroup: AgentListGroup = {
  title: "Tools",
  count: "5",
  note: "3 reached · 2 not",
  state: null,
  rows: [
    {
      kind: "item",
      entry: "tool/get_news",
      name: "get_news",
      description: "Latest items across all feeds",
      via: ["reader"],
      alsoVia: true,
      noEffect: false,
      sel: "tool:get_news",
      control: seg("tool/get_news", "allow", "allow", ["reader"]),
    },
    {
      kind: "item",
      entry: "tool/search_feeds",
      name: "search_feeds",
      description: "Find feeds by name or URL",
      via: ["reader"],
      alsoVia: false,
      noEffect: false,
      sel: "tool:search_feeds",
      control: seg("tool/search_feeds", "none", "allow", ["reader"]),
    },
    {
      kind: "item",
      entry: "tool/admin_purge_cache",
      name: "admin_purge_cache",
      description: "Drop cached items",
      via: ["admin"],
      alsoVia: false,
      noEffect: false,
      sel: "tool:admin_purge_cache",
      control: seg("tool/admin_purge_cache", "none", "approval", ["admin"]),
    },
    {
      kind: "item",
      entry: "tool/publish",
      name: "publish",
      description: "Post an item to a feed",
      via: [],
      alsoVia: true,
      noEffect: false,
      sel: "tool:publish",
      control: seg("tool/publish", "approval"),
    },
    {
      kind: "item",
      entry: "tool/subscribe",
      name: "subscribe",
      description: "Subscribe to a feed",
      via: [],
      alsoVia: false,
      noEffect: false,
      sel: "tool:subscribe",
      control: seg("tool/subscribe", "none"),
    },
  ],
};

const promptsGroup: AgentListGroup = {
  title: "Prompts",
  count: "1",
  note: "",
  state: null,
  rows: [
    {
      kind: "item",
      entry: "prompt/digest_daily",
      name: "digest_daily",
      description: "Summarise the last 24 h",
      via: ["reader"],
      alsoVia: false,
      noEffect: false,
      sel: "prompt:digest_daily",
      control: seg("prompt/digest_daily", "none", "allow", ["reader"]),
    },
  ],
};

const resourcesGroup: AgentListGroup = {
  title: "Resources",
  count: "2",
  note: "matched by URI",
  state: null,
  rows: [
    {
      kind: "item",
      entry: "resource/news://feed/hn",
      name: "news://feed/hn",
      description: "text/plain",
      via: ["resource/news://feed/*"],
      alsoVia: false,
      noEffect: false,
      sel: "resource:news://feed/hn",
      control: seg("resource/news://feed/hn", "none", "allow", ["resource/news://feed/*"]),
    },
    {
      kind: "item",
      entry: "resource/news://config",
      name: "news://config",
      description: "application/json",
      via: [],
      alsoVia: false,
      noEffect: false,
      sel: "resource:news://config",
      control: seg("resource/news://config", "none"),
    },
  ],
};

const patternsGroup: AgentListGroup = {
  title: "Patterns",
  count: "1",
  note: "entries that are not one item",
  state: null,
  rows: [
    {
      kind: "pattern",
      entry: "resource/news://feed/*",
      detail: "matches 2 today",
      dormant: false,
      sel: "pattern:resource/news://feed/*",
      control: seg("resource/news://feed/*", "allow"),
    },
  ],
};

const appGroups: AgentListGroup[] = [rolesGroup, toolsGroup, promptsGroup, resourcesGroup, patternsGroup];

/** The details of `get_news` — the board's own selection, reached through a role. */
const toolDetails: AgentDetailsView = {
  kind: "item",
  entry: "tool/get_news",
  name: "get_news",
  family: "tool",
  description: "Latest items across all feeds",
  standing: "allowed · via reader",
  approval:
    "Not asked — allow wins over any ask entry, so adding one here would not gate it while reader allows it.",
  args: [{ name: "since", type: "string", required: false, hasDefault: false }],
  hub: {
    aggregated: "news_get_news",
    reachableBy: "claude · via reader, cron · via reader",
    redaction: "none",
  },
};

const noSelection: AgentDetailsView = {
  kind: "none",
  appName: "News MCP",
  appKind: "tunnel",
  catalog: {
    tools: { reached: 3, total: 5, approval: 1 },
    prompts: { reached: 1, total: 1, approval: 0 },
    resources: { reached: 1, total: 2, approval: 0 },
    roles: ["reader", "admin", "publisher"],
  },
  allowed: ["reader", "tool/get_news", "resource/news://feed/*"],
  askFirst: ["admin", "tool/publish"],
};

/** The app pane, as every one of its states starts from. */
const appPane = (over: Partial<Extract<AgentPaneView, { kind: "app" }>> = {}): AgentPaneView => ({
  kind: "app",
  app: "news",
  appName: "News MCP",
  appKind: "tunnel",
  status: "online",
  newGrant: false,
  reach: {
    tools: { reached: 3, total: 5, approval: 1 },
    prompts: { reached: 1, total: 1, approval: 0 },
    resources: { reached: 1, total: 2, approval: 0 },
  },
  q: "",
  groups: appGroups,
  offer: null,
  nothingMatches: false,
  saved: { allow: 3, approval: 2 },
  carry: [],
  details: toolDetails,
  error: null,
  ...over,
});

const agentTokenRows: AgentTokenRow[] = [
  {
    id: "tok_4kJk9fQ",
    prefix: "pmcp_agt_4kJk…9fQ",
    createdAt: ms("2026-08-12T09:00:00.000Z"),
    expiresAt: ms("2026-11-10T09:00:00.000Z"),
    lastUsedAt: ms("2026-08-24T12:47:00.000Z"),
    expired: false,
  },
  {
    id: "tok_2mQv8xT",
    prefix: "pmcp_agt_2mQv…8xT",
    createdAt: ms("2026-05-14T09:00:00.000Z"),
    expiresAt: ms("2026-08-12T09:00:00.000Z"),
    lastUsedAt: ms("2026-07-30T18:20:00.000Z"),
    expired: true,
  },
];

const agentClientRows: AgentClientRow[] = [
  {
    id: "conn_9f2a",
    name: "Claude",
    origin: "https://claude.ai",
    revoked: false,
    createdAt: ms("2026-08-14T10:00:00.000Z"),
    lastUsedAt: ms("2026-08-24T12:47:00.000Z"),
    selfRegistered: false,
  },
];

const credentialsPane = (details: AgentCredentialsDetails, issuedId: string | null = null): AgentPaneView => ({
  kind: "credentials",
  tokens: agentTokenRows,
  clients: agentClientRows,
  issuedId,
  details,
});

const waitingRows: AgentApprovalRow[] = [
  {
    id: "apr_01",
    app: "news",
    tool: "admin_purge_cache",
    args: '{"scope":"feeds","older_than":"7d"}',
    createdAt: "2026-08-24T14:35:00.000Z",
    expiresAt: "2026-08-24T15:35:00.000Z",
    status: "pending",
    sel: "approval:apr_01",
  },
  {
    id: "apr_02",
    app: "news",
    tool: "admin_reindex",
    args: '{"feed":"hn"}',
    createdAt: "2026-08-24T14:06:00.000Z",
    expiresAt: "2026-08-24T15:06:00.000Z",
    status: "pending",
    sel: "approval:apr_02",
  },
  /** Decided from this pane a moment ago: it stays listed, dimmed, wearing its status —
   *  the count above it is the two still waiting, not this list's length. */
  {
    id: "apr_03",
    app: "linear",
    tool: "close_issue",
    args: '{"id":"ENG-41"}',
    createdAt: "2026-08-24T13:12:00.000Z",
    expiresAt: "2026-08-24T14:12:00.000Z",
    status: "approved",
    sel: "approval:apr_03",
  },
];

const callRows: AgentCallRow[] = [
  {
    id: 4101,
    app: "linear",
    tool: "list_issues",
    ts: ms("2026-08-24T12:47:00.000Z"),
    durationMs: 412,
    outcome: "ok",
    sel: "call:4101",
  },
  {
    id: 4102,
    app: "news",
    tool: "search_items",
    ts: ms("2026-08-24T12:40:00.000Z"),
    durationMs: 88,
    outcome: "ok",
    sel: "call:4102",
  },
  {
    id: 4103,
    app: "news",
    tool: "admin_purge_cache",
    ts: ms("2026-08-24T11:47:00.000Z"),
    durationMs: 6,
    outcome: "approval required",
    sel: "call:4103",
  },
];

/** A full page of the walk: twenty rows, so the Load-more foot has a page to sit under. */
const pagedCalls: AgentCallRow[] = Array.from({ length: 20 }, (_unused, index) => ({
  id: 4200 + index,
  app: index % 3 === 0 ? "linear" : "news",
  tool: index % 3 === 0 ? "list_issues" : "search_items",
  ts: ms("2026-08-24T12:40:00.000Z") - index * HOUR,
  durationMs: 40 + index,
  outcome: "ok",
  sel: `call:${4200 + index}`,
}));

const activityPane = (details: AgentActivityDetails, over: Partial<Extract<AgentPaneView, { kind: "activity" }>> = {}): AgentPaneView => ({
  kind: "activity",
  summary: { calls: 3, ok: 2, denied: 0, pending: 2 },
  requests: waitingRows,
  calls: callRows,
  moreHref: null,
  details,
  ...over,
});

const grantEndpoints = [
  { family: "tool", name: "list_prs", description: "Open pull requests", roles: ["reader"] },
  { family: "tool", name: "get_pr", description: "One pull request", roles: ["reader"] },
  { family: "tool", name: "merge_pr", description: "Merge a pull request", roles: [] },
  { family: "tool", name: "create_issue", description: "Open an issue", roles: [] },
];

const grantCard = (over: Partial<AgentGrantCard> = {}): AgentGrantCard => ({
  slug: "gh",
  name: "GitHub",
  kind: "proxy",
  status: "connected",
  description: "Repositories, pull requests and issues over the GitHub MCP",
  counts: "",
  roles: ["reader"],
  toggle: "show endpoints",
  open: false,
  endpoints: [],
  ...over,
});

/**
 * The query the fixture's own URL carried, as far as the three levels care: a details
 * column showing a picked row is a URL that named one with `sel`. Only its PRESENCE is
 * read (the name comes off the details view itself), so the value is a placeholder.
 */
const agentQuery = (pane: AgentPaneView): URLSearchParams =>
  new URLSearchParams("details" in pane && pane.details.kind !== "none" ? { sel: "picked" } : {});

/**
 * One fixture's whole props, so each entry below says only what makes it that state.
 *
 * The narrow level is not stated per fixture: it is `agentLevel`'s, off the same URL a
 * request would carry, so a fixture cannot claim a level the page would not give it.
 * `landing` is the one bit a fixture has to say, because the landing renders a pane in
 * place and is otherwise indistinguishable from that pane's own URL.
 */
const agentPage = (
  rail: string,
  pane: AgentPaneView,
  over: Partial<AgentDetailProps> = {},
  landing = false,
): AgentDetailProps => ({
  ...shell("agents"),
  csrfToken: CSRF,
  header: agentHeader(),
  rail: agentRail(rail),
  pane,
  confirm: null,
  reveal: null,
  ...agentLevel("claude", pane, agentQuery(pane), landing),
  ...over,
});

const agentDetail = {
  /** The artboard: the `news` pane with `get_news` selected, reached through `reader`. */
  default: agentPage("news", appPane()),
  /** A role selected: its patterns, what they match today, and the widening note. */
  roleSelected: agentPage(
    "news",
    appPane({
      details: {
        kind: "role",
        entry: "reader",
        builtin: false,
        source: "Declared by News MCP at connect.",
        standing: "allow",
        patterns: [
          ["tools", ["get_news", "search_.*"]],
          ["prompts", ["digest_.*"]],
        ],
        matches: [
          ["tools", ["get_news", "search_feeds"]],
          ["prompts", ["digest_daily"]],
          ["resources", []],
        ],
      },
    }),
  ),
  /** A pattern entry selected: what it matches today, by name. */
  patternSelected: agentPage(
    "news",
    appPane({
      details: {
        kind: "pattern",
        entry: "resource/news://feed/*",
        standing: "allow",
        matches: ["news://feed/hn", "news://feed/lobsters"],
      },
    }),
  ),
  /** A resource selected: no arguments and no hub block — neither is a resource's. */
  resourceSelected: agentPage(
    "news",
    appPane({
      details: {
        kind: "item",
        entry: "resource/news://config",
        name: "news://config",
        family: "resource",
        description: "application/json",
        standing: "not reachable",
        approval: "—",
        args: null,
        hub: null,
      },
    }),
  ),
  /** Typed text that is not one name: offered as a pattern entry, with Ask / Allow. */
  filterOffer: agentPage(
    "news",
    appPane({
      q: "admin_*",
      groups: [toolsGroup],
      offer: { entry: "tool/admin_*", detail: "would match 3 today, and any added later" },
      details: noSelection,
    }),
  ),
  /** A filter nothing answers: the patterns stay, everything else goes. */
  filterNothing: agentPage(
    "news",
    appPane({
      q: "zzz",
      groups: [patternsGroup],
      nothingMatches: true,
      details: noSelection,
    }),
  ),
  /** Straight after Grant on the grant step: an empty set, the dashed badge. */
  newGrant: agentPage(
    "gh",
    appPane({
      app: "gh",
      appName: "GitHub",
      appKind: "proxy",
      status: "connected",
      newGrant: true,
      reach: {
        tools: { reached: 0, total: 4, approval: 0 },
        prompts: { reached: 0, total: 0, approval: 0 },
        resources: { reached: 0, total: 0, approval: 0 },
      },
      groups: [],
      saved: { allow: 0, approval: 0 },
      details: {
        kind: "none",
        appName: "GitHub",
        appKind: "proxy",
        catalog: {
          tools: { reached: 0, total: 4, approval: 0 },
          prompts: { reached: 0, total: 0, approval: 0 },
          resources: { reached: 0, total: 0, approval: 0 },
          roles: ["reader"],
        },
        allowed: [],
        askFirst: [],
      },
    }),
  ),
  /** Remove from claude, confirming: the dialog whose form clears the whole set. */
  confirmRemove: agentPage("news", appPane(), { confirm: { kind: "remove-app", app: "news" } }),
  /** A held role the app has not declared: kept, badged, removable by its own ×. */
  undeclaredRole: agentPage(
    "news",
    appPane({
      groups: [
        rolesGroup,
        { title: "", count: "", note: "", state: null, rows: [{ kind: "undeclared", entry: "editor", standing: "allow" }] },
        toolsGroup,
      ],
      details: noSelection,
    }),
  ),
  /** A direct ask under a role that allows: allow wins, so the entry is badged. */
  noEffect: agentPage(
    "news",
    appPane({
      groups: [
        {
          ...toolsGroup,
          rows: [
            {
              kind: "item",
              entry: "tool/get_news",
              name: "get_news",
              description: "Latest items across all feeds",
              via: ["reader"],
              alsoVia: true,
              noEffect: true,
              sel: "tool:get_news",
              control: seg("tool/get_news", "approval", "allow", ["reader"]),
            },
          ],
        },
      ],
      details: noSelection,
    }),
  ),
  /** A tunneled app that has never connected: one note line in place of every family. */
  unconnected: agentPage(
    "home",
    appPane({
      app: "home",
      appName: "Home Assistant",
      status: "offline",
      reach: {
        tools: { reached: 0, total: 0, approval: 0 },
        prompts: { reached: 0, total: 0, approval: 0 },
        resources: { reached: 0, total: 0, approval: 0 },
      },
      groups: [
        {
          title: "Tools",
          count: "",
          note: "",
          state: "home has not connected yet — nothing to list until it does.",
          rows: [],
        },
      ],
      saved: { allow: 0, approval: 1 },
      details: {
        kind: "none",
        appName: "Home Assistant",
        appKind: "tunnel",
        catalog: {
          tools: { reached: 0, total: 0, approval: 0 },
          prompts: { reached: 0, total: 0, approval: 0 },
          resources: { reached: 0, total: 0, approval: 0 },
          roles: [],
        },
        allowed: [],
        askFirst: ["lights"],
      },
    }),
  ),
  /** A refused save: the reason above the listing, the submitted choices still there. */
  refused: agentPage(
    "news",
    appPane({
      error: '"roles" entry "tool/(" is not a valid pattern',
      details: noSelection,
    }),
  ),

  /** The grant step: one card per active app the agent holds nothing on. */
  grant: agentPage("grant", { kind: "grant", q: "", cards: [grantCard()], total: 1 }),
  /** `?show=gh`: the endpoint list and the roles that grant each one. */
  grantShowAll: agentPage("grant", {
    kind: "grant",
    q: "",
    cards: [grantCard({ open: true, toggle: "hide", counts: "4 tools", endpoints: grantEndpoints })],
    total: 1,
  }),
  /** A search that matched inside a card: it opens, showing only what matched. */
  grantSearch: agentPage("grant", {
    kind: "grant",
    q: "merge",
    cards: [grantCard({ open: true, toggle: "hide", counts: "4 tools", endpoints: [grantEndpoints[2] as AgentEndpointRow] })],
    total: 1,
  }),
  /** Every active app already granted: the sentence, and no card at all. */
  grantEverywhere: agentPage("grant", { kind: "grant", q: "", cards: [], total: 0 }),

  /** Credentials with nothing selected: the summary card. */
  credentials: agentPage("credentials", credentialsPane({ kind: "none", tokens: 2, clients: 1 })),
  /** A live key selected: what it carries, and the agent's own recent calls. */
  credentialsTokenSelected: agentPage(
    "credentials",
    credentialsPane({
      kind: "token",
      row: agentTokenRows[0] as AgentTokenRow,
      recent: [
        { ts: ms("2026-08-24T12:47:00.000Z"), app: "linear", tool: "list_issues" },
        { ts: ms("2026-08-24T12:40:00.000Z"), app: "news", tool: "search_items" },
        { ts: ms("2026-08-24T11:47:00.000Z"), app: "news", tool: "admin_purge_cache" },
      ],
    }),
  ),
  /** Right after Issue token: the once-only reveal, and the row marked `new`. */
  credentialsIssued: agentPage(
    "credentials",
    credentialsPane({ kind: "none", tokens: 2, clients: 1 }, "tok_4kJk9fQ"),
    { reveal: "pmcp_agt_7QmFAKE0000000000000000000000000000" },
  ),
  /** An expired key selected: the row's verb reads Remove, not Revoke. */
  credentialsExpiredSelected: agentPage(
    "credentials",
    credentialsPane({ kind: "token", row: agentTokenRows[1] as AgentTokenRow, recent: [] }),
  ),
  /** Revoke, confirming. */
  credentialsConfirmRevoke: agentPage(
    "credentials",
    credentialsPane({ kind: "none", tokens: 2, clients: 1 }),
    { confirm: { kind: "revoke-token", id: "tok_4kJk9fQ", prefix: "pmcp_agt_4kJk…9fQ" } },
  ),
  /** Remove, on the expired one — the same op, said the way an expired key deserves. */
  credentialsConfirmRemoveExpired: agentPage(
    "credentials",
    credentialsPane({ kind: "none", tokens: 2, clients: 1 }),
    {
      confirm: {
        kind: "remove-token",
        id: "tok_2mQv8xT",
        prefix: "pmcp_agt_2mQv…8xT",
        expiresAt: ms("2026-08-12T09:00:00.000Z"),
      },
    },
  ),
  /** The OAuth client selected: read-only, pointing at the pane that revokes. */
  credentialsClientSelected: agentPage(
    "credentials",
    credentialsPane({ kind: "client", row: agentClientRows[0] as AgentClientRow }),
  ),

  /** Activity with nothing selected: the seven-day summary. */
  activity: agentPage("activity", activityPane({ kind: "none", calls: 3, ok: 2, denied: 0, pending: 2 })),
  /** A waiting request selected: its arguments, why it waits, and the two buttons. */
  activityApprovalSelected: agentPage(
    "activity",
    activityPane({
      kind: "approval",
      row: waitingRows[0] as AgentApprovalRow,
      why: "admin is in Ask first on news",
    }),
  ),
  /** A refused call: no bodies were ever recorded, and the pane says why. */
  activityCallRefused: agentPage(
    "activity",
    activityPane({
      kind: "call",
      row: callRows[2] as AgentCallRow,
      noBodies: "refused",
      args: null,
      result: null,
    }),
  ),
  /** A call that ran: arguments and result, both post-redaction. */
  activityCallOk: agentPage(
    "activity",
    activityPane({
      kind: "call",
      row: callRows[1] as AgentCallRow,
      noBodies: null,
      args: '{\n  "query": "cloudflare outage",\n  "cookie": "‹redacted›"\n}',
      result: '{\n  "items": [\n    { "id": "hn-1", "title": "Cloudflare restores service" }\n  ]\n}',
    }),
  ),

  /** A full page with more behind it: the Load-more row and what it does not know. */
  activityPaged: agentPage(
    "activity",
    activityPane({ kind: "none", calls: 20, ok: 20, denied: 0, pending: 2 }, {
      summary: { calls: 20, ok: 20, denied: 0, pending: 2 },
      calls: pagedCalls,
      moreHref: "/agents/claude/activity?calls=40",
    }),
  ),
  /** The last page of a walked week: no link, and the sentence that says why. */
  activityEnd: agentPage(
    "activity",
    activityPane({ kind: "none", calls: 23, ok: 22, denied: 0, pending: 2 }, {
      summary: { calls: 23, ok: 22, denied: 0, pending: 2 },
      calls: [...pagedCalls, ...callRows],
      moreHref: null,
    }),
  ),

  /** The danger zone: the delete card, and what deletion removes. */
  danger: agentPage("danger", { kind: "danger", grants: 3, tokens: 2, clients: 1 }),

  /* The three levels below the breakpoint (MobileAgentDetail.dc.html,
     MobileAgentDetailStates.dc.html) — the SAME props as `default` but for the URL each
     came from, which is the only thing that decides a level. Wide they are identical: the
     attribute is read by the narrow stylesheet alone, so seeing the difference means
     narrowing the window. */

  /** `/agents/claude` — the landing: the tiles and the rail as a full-width list. */
  narrowLevel1: agentPage("news", appPane({ details: noSelection }), {}, true),
  /** `/agents/claude/apps/news` — the listing alone, its header without the app's name. */
  narrowLevel2: agentPage("news", appPane({ details: noSelection })),
  /** `/agents/claude/apps/news?sel=tool:get_news` — the details alone, `‹ News MCP` up. */
  narrowLevel3: agentPage("news", appPane()),
} satisfies Record<string, AgentDetailProps>;

export const fixtures: { [K in keyof PagePropsByName]: Record<string, PagePropsByName[K]> } = {
  login,
  device,
  settings,
  apps,
  "app-detail": appDetailFixtures,
  "app-new": appNew,
  agents,
  "agent-detail": agentDetail,
  "agent-new": agentNew,
  approvals,
  "approval-detail": approvalDetail,
  audit,
  "oauth-consent": oauthConsent,
};

export {
  login,
  device,
  settings,
  apps,
  appDetailFixtures,
  appNew,
  approvals,
  approvalDetail,
  audit,
  oauthConsent,
};
