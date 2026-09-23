import { keys } from "@/lib/queries";
import type {
  ConnectionRow,
  PasskeyRow,
  SessionRow,
  SettingsRead,
  SettingsTokenRow,
  TotpEnrollment,
} from "@/lib/types";
import type { Seed } from "../seed";
import { pendingCreatePage, pendingSetScene } from "./approvals";
import { TOTP_QR_SVG } from "./totp-qr";

/**
 * `/settings`, reproduced from `server/dev/fixtures.ts`' `settings` object one state for one
 * state and one value for one value — the same passkeys, sessions, tokens, clients, timeouts,
 * enrolment and codes, against the same frozen `NOW` (`../clock.ts`).
 *
 * The translation from page props to what the client reads: the six lists and the timeout
 * pair are the ONE settings read (`SettingsRead`); `pane` is the URL's path; `tokenKind`,
 * `confirm` and the flash (with the Password pane's `field` / `signedOut`) are its query; the
 * shell's `pendingApprovals` is the pending set the nav badge counts; and the three things a
 * POST answers once — an enrolment, a code set, a refused Execution pair — ride the preview
 * transient, because nothing caches them.
 */

/* ------------------------------ the one cast ------------------------------ */

const passkeys: PasskeyRow[] = [
  { id: "pk_7f2a91", name: "Windows Hello", addedAt: "2026-03-12T09:14:00.000Z", lastUsedAt: "2026-08-23T21:02:00.000Z" },
  {
    id: "pk_1c8e40",
    name: "Google Password Manager",
    addedAt: "2026-01-08T17:40:00.000Z",
    lastUsedAt: "2026-08-02T08:25:00.000Z",
  },
  { id: "pk_9a04dd", name: "Passkey", addedAt: "2026-06-30T13:05:00.000Z", lastUsedAt: "2026-08-18T19:22:00.000Z" },
];

/** The current session was minted four minutes before NOW — the Password pane prints the
 *  difference as "Confirmed your identity 4 minutes ago." */
const current: SessionRow = {
  id: "ses_9d21ba",
  client: "Chrome on Windows",
  source: "web",
  createdAt: "2026-08-24T14:43:00.000Z",
  lastActiveAt: "2026-08-24T14:47:00.000Z",
  current: true,
};

const sessions: SessionRow[] = [
  current,
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

const ms = (iso: string): number => Date.parse(iso);

const tokens: SettingsTokenRow[] = [
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

/** `enrollmentOf(TOTP_URI, error)`'s answer — the fixture's URI, its QR, and the secret in
 *  fours — as the enable (and a refused verify) hands it to the page. */
const enrollment = (error: string | null): TotpEnrollment => ({
  totpUri: "otpauth://totp/personal-mcps:owner?secret=JBSWY3DPEHPK3PXP&issuer=personal-mcps",
  qrDataUri: `data:image/svg+xml;utf8,${encodeURIComponent(TOTP_QR_SVG)}`,
  secret: "JBSW Y3DP EHPK 3PXP",
  error,
});

/** better-auth's own shape: ten codes of two five-character halves. */
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

/** What every state reads — the rail draws every list on every pane, so a state carrying only
 *  its own pane's rows would draw a rail of zeroes. The limits are the server's constants. */
const base: SettingsRead = {
  twoFactor: { enabled: true },
  passkeys,
  sessions,
  tokens,
  connections,
  execution: { defaultTimeoutMs: 30_000, maxTimeoutMs: 300_000 },
  limits: { passwordMinLength: 12, minTimeoutMs: 1_000, maxTimeoutMs: 300_000 },
};

/**
 * One state: the pane's URL, the read (the base with this state's differences), and the
 * pending set — `shell("settings")`'s two, or none for the states that spell
 * `shell("settings", 0)`.
 */
const state = (
  path: string,
  read: Partial<SettingsRead> = {},
  extra: { search?: Seed["search"]; pending?: 0 | 2; transient?: Seed["transient"] } = {},
): Seed => ({
  path,
  ...(extra.search === undefined ? {} : { search: extra.search }),
  ...(extra.transient === undefined ? {} : { transient: extra.transient }),
  queries: [
    { key: keys.settings(), data: { ...base, ...read } },
    { key: keys.approvalsPending(), data: { approvals: extra.pending === 0 ? [] : [pendingSetScene, pendingCreatePage] } },
  ],
});

/** A refused password change's landing, as `noticeUrl` writes it: the op, better-auth's own
 *  words where there are any, and the control §13 maps the refusal onto where it maps one. */
const refusedPassword = (reason: string | null, field?: string): Seed["search"] => ({
  failed: "change_password",
  ...(reason === null ? {} : { reason }),
  ...(field === undefined ? {} : { field }),
});

export const settingsSeeds: Record<string, Seed> = {
  /** Fully secured, landing on Password: TOTP on, three passkeys, three live sessions. */
  default: state("/settings"),

  /** SettingsStates' three Password refusals, each beside its own control. */
  passwordWrongCurrent: state("/settings", {}, { search: refusedPassword("Invalid password", "currentPassword") }),
  passwordTooShort: state("/settings", {}, { search: refusedPassword("Password too short", "newPassword") }),
  passwordMismatch: state("/settings", {}, { search: refusedPassword(null, "confirmPassword") }),

  /** The refusal that names no control — the only one drawn as a banner alone. */
  passwordRefused: state("/settings", {}, { search: refusedPassword("Password too long") }),

  /** The two success states, which differ in exactly the sentence the checkbox buys. */
  passwordUpdated: state("/settings", {}, { search: { done: "change_password" } }),
  passwordUpdatedSignedOut: state(
    "/settings",
    { sessions: [current] },
    { search: { done: "change_password", signedOut: "2" } },
  ),

  /** One state per pane. */
  twoFactor: state("/settings/two-factor"),
  passkeys: state("/settings/passkeys"),
  sessions: state("/settings/sessions"),
  tokens: state("/settings/tokens"),
  clients: state("/settings/clients"),
  execution: state("/settings/execution"),

  /**
   * §23.3's refused pair: the owner's own text in both boxes and the op's sentence under the
   * control it named. The sentence is the op's REAL one (`registry.ts`), which the SSR fixture
   * paraphrased as "Must not exceed max timeout."; the page shows what the op says.
   */
  executionRefused: state(
    "/settings/execution",
    {},
    {
      transient: {
        executionDraft: { defaults: "600000", maximum: "300000" },
        refusal: {
          reason: `"default_timeout_ms" must not exceed "max_timeout_ms"`,
          violations: [{ field: "default_timeout_ms", reason: `"default_timeout_ms" must not exceed "max_timeout_ms"` }],
        },
      },
    },
  ),

  /** SettingsStates "Two-factor — not enrolled": the rail dot unlit beside it. */
  bare: state("/settings/two-factor", { twoFactor: { enabled: false }, passkeys: [], sessions: [current] }, { pending: 0 }),

  /** SettingsPanes "Passkeys — empty". */
  passkeysEmpty: state("/settings/passkeys", { passkeys: [] }, { pending: 0 }),

  /** Registered passkeys that have never signed anybody in. */
  passkeysNeverUsed: state("/settings/passkeys", { passkeys: passkeys.map((pk) => ({ ...pk, lastUsedAt: null })) }),

  /** Both Access panes with nothing in them. */
  tokensEmpty: state("/settings/tokens", { tokens: [] }, { pending: 0 }),
  clientsEmpty: state("/settings/clients", { connections: [] }, { pending: 0 }),

  /** The Tokens pane under each half of the filter — the table narrows, and so does the rail's
   *  count, which is the rows the pane lists. */
  tokensAgents: state("/settings/tokens", {}, { search: { kind: "agent" } }),
  tokensApps: state("/settings/tokens", {}, { search: { kind: "app" } }),

  /** The filter narrowed to a kind this namespace holds none of. */
  tokensFilteredEmpty: state(
    "/settings/tokens",
    { tokens: tokens.filter((token) => token.kind === "agent") },
    { search: { kind: "app" } },
  ),

  /** A live client only. */
  clientsActiveOnly: state("/settings/clients", { connections: [connections[0]!] }),

  /** SettingsStates "TOTP setup": mid-enrolment, nothing stored yet. */
  totpEnrolling: state(
    "/settings/two-factor",
    { twoFactor: { enabled: false }, passkeys: [], sessions: [current] },
    { pending: 0, transient: { enrollment: enrollment(null) } },
  ),

  /** The code did not verify — the same enrolment, redrawn with better-auth's own sentence. */
  totpEnrollError: state(
    "/settings/two-factor",
    { twoFactor: { enabled: false }, passkeys: [], sessions: [current] },
    { pending: 0, transient: { enrollment: enrollment("Invalid code") } },
  ),

  /** SettingsStates "Backup codes": the one render that ever shows them. */
  backupCodesRevealed: state(
    "/settings/two-factor",
    { passkeys: [], sessions: [current] },
    { pending: 0, transient: { backupCodes: BACKUP_CODES } },
  ),

  /** Dialogs, each on the pane that owns it. */
  confirmDisableTwoFactor: state("/settings/two-factor", {}, { search: { confirm: "disable-two-factor" } }),
  confirmRemovePasskey: state("/settings/passkeys", {}, { search: { confirm: "remove-passkey", id: "pk_7f2a91" } }),
  confirmRevokeSession: state("/settings/sessions", {}, { search: { confirm: "revoke-session", id: "ses_4a77c0" } }),
  confirmRevokeOtherSessions: state("/settings/sessions", {}, { search: { confirm: "revoke-other-sessions" } }),
  confirmRevokeConnection: state("/settings/clients", {}, { search: { confirm: "revoke-connection", id: "con_claude01" } }),

  /** A failed better-auth write landed back on its pane with better-auth's own reason. */
  error: state("/settings/two-factor", {}, { search: { failed: "two_factor_disable", reason: "Invalid password" } }),

  /** Edge: a user agent nobody sized a column for. The SSR fixture draws the Passkeys pane, so
   *  the long session shows only as the rail's count — kept as it drew it. */
  longNames: state("/settings/passkeys", {
    sessions: [
      current,
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
  }),
};
