// fixtures.ts — every SERVER-RENDERED page state, as data.
//
// One namespace ("ahrzb"), one render instant (NOW), and one cast of credentials and
// approvals, so a reviewer flipping between pages sees a coherent hub rather than
// unrelated screenshots. Each entry is a complete, type-checked value of its page's
// Props: if model.ts changes shape, this file is where the break surfaces — before any
// template is touched.
//
// The states of /apps/* and /agents/* are NOT here: those pages are a React SPA, and
// their seeds live in web/src/preview/fixtures.ts. This file covers the pages web.ts
// still renders — /login, /device, /settings, /approvals, /approvals/<id> and
// /oauth/consent — and nothing else. /audit joined the SPA on 2026-09-21 (decision 36),
// so its states are web/src/preview/fixtures.ts's too.
//
// Nothing here is real. Tokens use an obviously-fake body (FAKE0000…) so a
// grep for a leaked credential can never land on this file, and every argument
// value that the hub would mask is already spelled "‹redacted›" — fixtures show
// the post-redaction form because that is the only form the hub ever stores or
// displays (§7).
//
// Coverage rule: one rich default per page plus one fixture per distinct state
// the artboards show — empty lists, error banners and field errors, the
// once-only backup-code reveal, expired and spent approvals — and a long-content fixture
// wherever text can overflow.

import type {
  ConnectionRow,
  ConsentProps,
  SettingsProps,
  ShellProps,
  TokenRow,
  ApprovalDetailProps,
  ApprovalRow,
  ApprovalsProps,
  DeviceProps,
  LoginProps,
  NavSection,
  Notice,
  PagePropsByName,
  PasskeyRow,
  SessionRow,
} from "../src/pages/model";
// `enrollmentOf` is the ONE producer of an enrolment's three fields (§13/§15's own rule) —
// fixtures call it rather than hand-rolling a QR, so the preview can never draw a secret,
// a grouped display form and a QR that disagree with one another.
import { enrollmentOf } from "../src/pages/model";
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
  // §23.3's pair at the pinned defaults, drawn as the Execution pane's controls: the
  // committed values are milliseconds and the form's are the same numbers as text.
  execution: { defaultTimeoutMs: 30_000, maxTimeoutMs: 300_000 },
  executionForm: { defaults: "30000", maximum: "300000", errors: {} },
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

  /** One fixture per pane, so the preview index walks all seven of §13's routes. */
  twoFactor: { ...shell("settings"), ...settingsBase, pane: "two-factor" },
  passkeys: { ...shell("settings"), ...settingsBase, pane: "passkeys" },
  sessions: { ...shell("settings"), ...settingsBase, pane: "sessions" },
  tokens: { ...shell("settings"), ...settingsBase, pane: "tokens" },
  clients: { ...shell("settings"), ...settingsBase, pane: "clients" },
  execution: { ...shell("settings"), ...settingsBase, pane: "execution" },

  /** §23.3's refused pair: the op's sentence under the control it named, and the owner's
   *  own text in both boxes rather than the pair that was refused. */
  executionRefused: {
    ...shell("settings"),
    ...settingsBase,
    pane: "execution",
    executionForm: {
      defaults: "600000",
      maximum: "300000",
      errors: { defaults: "Must not exceed max timeout." },
    },
  },

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
    // Owner-declared redaction path (§7: create_page → credentials.token).
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

export const fixtures: { [K in keyof PagePropsByName]: Record<string, PagePropsByName[K]> } = {
  login,
  device,
  settings,
  approvals,
  "approval-detail": approvalDetail,
  "oauth-consent": oauthConsent,
};

export {
  login,
  device,
  settings,
  approvals,
  approvalDetail,
  oauthConsent,
};
