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
  SettingsProps,
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
  AppNewProps,
  AppRow,
  AppsProps,
  SessionRow,
} from "../src/pages/model";

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

const passkeys: PasskeyRow[] = [
  {
    id: "pk_7f2a91",
    name: "MacBook Touch ID",
    addedAt: "2026-03-12T09:14:00.000Z",
    lastUsedAt: "2026-08-23T21:02:00.000Z",
  },
  {
    id: "pk_1c8e40",
    name: "YubiKey 5C",
    addedAt: "2026-01-08T17:40:00.000Z",
    lastUsedAt: "2026-08-02T08:25:00.000Z",
  },
];

const sessions: SessionRow[] = [
  {
    id: "ses_9d21ba",
    client: "Chrome on Windows",
    source: "web",
    createdAt: "2026-08-24T08:03:00.000Z",
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

/** A 140×140 stand-in for the enrollment QR — self-contained, no external fetch. */
const QR_PLACEHOLDER =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='140' height='140'>" +
      "<rect width='140' height='140' fill='#f4f4f5'/>" +
      "<text x='70' y='76' text-anchor='middle' font-family='monospace' " +
      "font-size='13' fill='#71717a'>QR</text></svg>",
  );

const BACKUP_CODES = [
  "a1b2-c3d4",
  "e5f6-a7b8",
  "c9d0-e1f2",
  "a3b4-c5d6",
  "e7f8-a9b0",
  "c1d2-e3f4",
  "a5b6-c7d8",
  "e9f0-a1b2",
];

const agent = {
  /** Fully secured: TOTP on, two passkeys, three live sessions. */
  default: {
    ...shell("settings"),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 8,
      generatedAt: "2026-03-02T11:20:00.000Z",
    },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys,
    sessions,
    confirm: null,
  },

  /** SettingsStates "Two-factor — not enrolled" and "Passkeys — empty" together. */
  bare: {
    ...shell("settings", 0),
    csrfToken: CSRF,
    twoFactor: { enabled: false },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys: [],
    sessions: [sessions[0]!],
    confirm: null,
  },

  /** SettingsStates "TOTP setup": mid-enrollment, nothing stored yet. */
  totpEnrolling: {
    ...shell("settings", 0),
    csrfToken: CSRF,
    twoFactor: { enabled: false },
    enrollment: {
      qrDataUri: QR_PLACEHOLDER,
      secret: "JBSW Y3DP EHPK 3PXP",
      error: null,
    },
    revealedBackupCodes: null,
    passkeys: [],
    sessions: [sessions[0]!],
    confirm: null,
  },

  /** The enrollment code did not verify — the setup card re-renders with the error. */
  totpEnrollError: {
    ...shell("settings", 0),
    csrfToken: CSRF,
    twoFactor: { enabled: false },
    enrollment: {
      qrDataUri: QR_PLACEHOLDER,
      secret: "JBSW Y3DP EHPK 3PXP",
      error: "That code didn't match. Check your device's clock and try again.",
    },
    revealedBackupCodes: null,
    passkeys: [],
    sessions: [sessions[0]!],
    confirm: null,
  },

  /** SettingsStates "Backup codes": the one render that ever shows them. */
  backupCodesRevealed: {
    ...shell("settings", 0, {
      tone: "success",
      message: "Two-factor authentication is on.",
    }),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 8,
      generatedAt: NOW,
    },
    enrollment: null,
    revealedBackupCodes: BACKUP_CODES,
    passkeys: [],
    sessions: [sessions[0]!],
    confirm: null,
  },

  /** Dialogs "Disable two-factor" — password-confirmed, destructive. */
  confirmDisableTwoFactor: {
    ...shell("settings"),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 8,
      generatedAt: "2026-03-02T11:20:00.000Z",
    },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys,
    sessions,
    confirm: { kind: "disable-two-factor" },
  },

  /** Dialogs "Remove passkey". */
  confirmRemovePasskey: {
    ...shell("settings"),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 8,
      generatedAt: "2026-03-02T11:20:00.000Z",
    },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys,
    sessions,
    confirm: { kind: "remove-passkey", id: "pk_7f2a91", name: "MacBook Touch ID" },
  },

  /** Dialogs, same pattern: revoking the CLI's device-flow session. */
  confirmRevokeSession: {
    ...shell("settings"),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 8,
      generatedAt: "2026-03-02T11:20:00.000Z",
    },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys,
    sessions,
    confirm: { kind: "revoke-session", id: "ses_4a77c0", client: "pmcp CLI" },
  },

  /** A failed better-auth mutation redirected back with its reason. */
  error: {
    ...shell("settings", 2, {
      tone: "danger",
      title: "Could not disable two-factor",
      message: "That password was not accepted. Nothing was changed.",
    }),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 7,
      generatedAt: "2026-03-02T11:20:00.000Z",
    },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys,
    sessions,
    confirm: null,
  },

  /** Edge: authenticator names and user agents nobody sized a column for. */
  longNames: {
    ...shell("settings"),
    csrfToken: CSRF,
    twoFactor: {
      enabled: true,
      backupCodesRemaining: 1,
      generatedAt: "2026-03-02T11:20:00.000Z",
    },
    enrollment: null,
    revealedBackupCodes: null,
    passkeys: [
      {
        id: "pk_长_0001",
        name: "Windows Hello on DESKTOP-QK7ZP2X (Enhanced Sign-in Security, TPM 2.0 platform authenticator)",
        addedAt: "2026-02-01T00:00:00.000Z",
        lastUsedAt: null,
      },
      ...passkeys,
    ],
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
    confirm: null,
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

  /** AppNewStates "SLUG ERROR": the reserved builtin, refused uniformly (§8). */
  slugReserved: {
    now: NOW,
    username: "ahrzb",
    csrfToken: CSRF,
    step: {
      kind: "form",
      form: { kind: "tunnel", name: "PMCP", slug: "pmcp", endpoint: "", authMode: "headers" },
      errors: { slug: "This slug is reserved." },
    },
  },

  /** Charset rejection — slugs are [a-z0-9-], no underscore (§2). */
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
      errors: { slug: "Slugs are lowercase letters, digits, and dashes." },
    },
  },

  /** Every field wrong at once, plus a whole-form failure. */
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
        name: "Give the app a display name.",
        slug: "You already have an app called notion.",
        endpoint: "Enter a full https:// URL.",
        form: "Nothing was created.",
      },
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

const pendingSetScene: ApprovalRow = {
  id: "apr_8f2k",
  agentSlug: "claude",
  appSlug: "home",
  tool: "set_scene",
  args: { scene: "movie_night" },
  status: "pending",
  createdAt: "2026-08-24T14:29:55.000Z",
  decidedAt: null,
  expiresAt: "2026-08-24T15:29:55.000Z",
};

const pendingCreatePage: ApprovalRow = {
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
};

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

/** 27 six-hour buckets across the visible week; the peak is the highlighted bar. */
const auditHistogram: AuditHistogram = {
  bucketMs: 6 * HOUR,
  buckets: [
    20, 55, 43, 27, 17, 57, 69, 35, 24, 64, 51, 40, 14, 45, 62, 32, 26, 119, 83, 47, 19, 69,
    56, 31, 25, 79, 75,
  ].map((count, i) => ({
    start: new Date(AUDIT_SINCE + i * 6 * HOUR).toISOString(),
    count,
  })),
  peak: 119,
};

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
    // A refusal never carries bodies (§15) — the detail names the class instead.
    detail: { reason: "app archived" },
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
  },
];

const auditOptions = {
  principals: ["agent:claude", "agent:cron", "app:news", "app:home", "user:ahrzb", "bootstrap"],
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

const audit = {
  /** The artboard: last 7 days, first page, one row's detail open. */
  default: {
    ...shell("audit"),
    filters: {
      range: "7d",
      since: AUDIT_SINCE,
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
    histogram: auditHistogram,
    expandedId: 41284,
    retentionDays: 7,
  },

  /** Deep in the result set: both pager arrows live, nothing expanded. */
  middlePage: {
    ...shell("audit"),
    filters: {
      range: "7d",
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
    histogram: auditHistogram,
    expandedId: null,
    retentionDays: 7,
  },

  /** A session link followed (?session=…): one agent conversation, narrow window. */
  filteredBySession: {
    ...shell("audit"),
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
    histogram: {
      bucketMs: 6 * HOUR,
      buckets: [0, 0, 1, 6].map((count, i) => ({
        start: new Date(ms("2026-08-23T12:00:00.000Z") + i * 6 * HOUR).toISOString(),
        count,
      })),
      peak: 6,
    },
    expandedId: null,
    retentionDays: 7,
  },

  /** EmptyStates "Audit — no results": filters narrower than the ledger. */
  empty: {
    ...shell("audit", 0),
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
    histogram: {
      bucketMs: 6 * HOUR,
      buckets: [],
      peak: 0,
    },
    expandedId: null,
    retentionDays: 7,
  },

  /**
   * Edge: bodies at the hygiene limits (§15) — an image result stubbed by type
   * and size, an over-cap argument body swapped whole for an `oversize` stub,
   * and a tool name long enough to fight its column.
   */
  bodyStubs: {
    ...shell("audit"),
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
        args: { width: 1440, height: 5200, theme: "light" },
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
    histogram: auditHistogram,
    expandedId: 41290,
    retentionDays: 7,
  },
} satisfies Record<string, AuditProps>;

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
  agent,
  apps,
  "app-new": appNew,
  approvals,
  "approval-detail": approvalDetail,
  audit,
};

export {
  login,
  device,
  agent,
  apps,
  appNew,
  approvals,
  approvalDetail,
  audit,
};
