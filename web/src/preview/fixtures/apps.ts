import { keys } from "@/lib/queries";
import type { AppRow, ApprovalRow, RoleDeclaration, TokenInfo, Violation } from "@/lib/types";
import type { Seed } from "../seed";

/**
 * `/apps` and `/apps/new`, reproduced from `server/dev/fixtures.ts`' `apps` and `appNew`
 * objects one state for one state and one value for one value — the same slugs, names,
 * endpoints, instants, role lists, token prefixes and sentences, because each state is
 * compared against its committed baseline pixel for pixel and a different value is a
 * different screenshot.
 *
 * The translation is the whole of the work here: the SSR fixtures are PAGE PROPS, and a
 * seed is the API responses the client reads to compute those props, plus the URL. So
 * `AppRow.connection`/`upstream`/`upstreamUrl`/`upstreamAuthMode` become the wire row's
 * `status`/`connection`/`endpoint`/`auth`, `tokenCount` becomes rows in `['tokens']` that
 * `liveTokenCounts` counts, the shell's `pendingApprovals` becomes rows in
 * `['approvals','pending']` that the nav badge counts, and a `notice` becomes the flash
 * search keys the server's redirect-back writes.
 */

/** Epoch milliseconds from a readable instant, as `server/dev/fixtures.ts`' own `ms`. */
const at = (iso: string): number => Date.parse(iso);

/** A row's DECLARED role names as a declaration. The listing renders names and never
 *  patterns (`rolesText` joins `Object.keys`), so the patterns are the empty set — the SSR
 *  fixtures carry a `roleNames` list and no patterns at all. */
const declared = (...names: string[]): RoleDeclaration =>
  Object.fromEntries(names.map((name) => [name, {}]));

/** What every row must carry and `/apps` never draws: the table shows name, slug, kind,
 *  status, roles and last seen, so the rest of §8's pinned shape sits at its
 *  nothing-to-say value. */
const REST = {
  description: "",
  logBodies: false,
  redact: {},
  redactResults: {},
  typescriptAliases: {},
  typescriptReservations: [],
  typescriptDiagnostics: [],
};

/* ------------------------------ the one cast ------------------------------ */

const news: AppRow = {
  ...REST,
  slug: "news",
  name: "News MCP",
  kind: "tunnel",
  archived: false,
  status: "online",
  lastSeen: at("2026-08-24T14:46:41.000Z"),
  roles: declared("reader", "admin"),
  ownerRoles: {},
  createdAt: at("2026-08-12T09:00:00.000Z"),
};

const notion: AppRow = {
  ...REST,
  slug: "notion",
  name: "Notion",
  kind: "proxy",
  archived: false,
  endpoint: "https://mcp.notion.com/mcp",
  auth: "headers",
  connection: "connected",
  roles: declared("editor", "reader"),
  createdAt: at("2026-07-02T10:30:00.000Z"),
};

const linear: AppRow = {
  ...REST,
  slug: "linear",
  name: "Linear",
  kind: "proxy",
  archived: false,
  endpoint: "https://mcp.linear.app/mcp",
  auth: "oauth",
  connection: "connected",
  roles: declared("reader"),
  createdAt: at("2026-07-18T08:15:00.000Z"),
};

const github: AppRow = {
  ...REST,
  slug: "github",
  name: "GitHub",
  kind: "proxy",
  archived: false,
  endpoint: "https://api.githubcopilot.com/mcp",
  auth: "oauth",
  connection: "needs_reconnect",
  roles: declared("reader", "triage"),
  createdAt: at("2026-06-05T17:40:00.000Z"),
};

const slack: AppRow = {
  ...REST,
  slug: "slack",
  name: "Slack",
  kind: "proxy",
  archived: false,
  endpoint: "https://mcp.slack.com/mcp",
  auth: "oauth",
  connection: "not_connected",
  roles: declared("reader"),
  createdAt: at("2026-08-01T12:00:00.000Z"),
};

/** Provisioned but never dialed in: no declaration, so no declared roles — and `lastSeen`
 *  null, which is NEVER and a different state from offline. */
const weather: AppRow = {
  ...REST,
  slug: "weather",
  name: "Weather bot",
  kind: "tunnel",
  archived: false,
  status: "offline",
  lastSeen: null,
  roles: {},
  ownerRoles: {},
  createdAt: at("2026-08-23T19:05:00.000Z"),
};

const home: AppRow = {
  ...REST,
  slug: "home",
  name: "Home automation",
  kind: "tunnel",
  archived: true,
  status: "offline",
  lastSeen: at("2026-08-20T21:14:00.000Z"),
  roles: {},
  ownerRoles: {},
  createdAt: at("2026-04-11T07:20:00.000Z"),
};

/** The long-data row spelled inline in `fixtures.ts`' `apps.longData`: a name, a slug, an
 *  endpoint and a role list past every column's comfort. */
const longRow: AppRow = {
  ...REST,
  slug: "internal-observability-and-incident-response-toolkit",
  name: "Internal observability and incident response toolkit (staging mirror)",
  kind: "proxy",
  archived: false,
  endpoint:
    "https://mcp.internal.example.com/observability/incident-response/v2/streamable-http?tenant=staging-mirror",
  auth: "oauth",
  connection: "needs_reconnect",
  roles: declared(
    "reader",
    "incident-responder",
    "dashboard-editor",
    "alert-router",
    "postmortem-author",
    "oncall-scheduler",
  ),
  createdAt: at("2026-05-20T14:00:00.000Z"),
};

/**
 * The credentials behind the SSR rows' `tokenCount` — news 2, weather 1, home 1, and none
 * for any proxied app, which has no tokens at all. The delete dialog's sentence is
 * `liveTokenCounts` over these, so the count has to come from rows rather than a number.
 */
const tokens: TokenInfo[] = [
  {
    id: "tok_9f3kXd2",
    kind: "app",
    refId: "app_news_0001",
    refSlug: "news",
    prefix: "pmcp_app_9f3k…Xd2",
    createdAt: at("2026-08-14T11:20:00.000Z"),
    expiresAt: null,
    lastUsedAt: at("2026-08-24T14:46:00.000Z"),
    revokedAt: null,
  },
  {
    id: "tok_5rTn8Wq",
    kind: "app",
    refId: "app_news_0001",
    refSlug: "news",
    prefix: "pmcp_app_5rTn…8Wq",
    createdAt: at("2026-08-19T09:45:00.000Z"),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  },
  {
    id: "tok_1cVb6Dz",
    kind: "app",
    refId: "app_weather_01",
    refSlug: "weather",
    prefix: "pmcp_app_1cVb…6Dz",
    createdAt: at("2026-08-23T19:06:00.000Z"),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
  },
  {
    id: "tok_8mHs3Pk",
    kind: "app",
    refId: "app_home_0001",
    refSlug: "home",
    prefix: "pmcp_app_8mHs…3Pk",
    createdAt: at("2026-04-11T07:21:00.000Z"),
    expiresAt: null,
    lastUsedAt: at("2026-08-20T21:14:00.000Z"),
    revokedAt: null,
  },
];

/**
 * The two pending approvals the shell's nav badge counts — `fixtures.ts`' own pending set,
 * which is why every state that spells `shell("apps")` shows a 2 and the two that spell
 * `shell("apps", 0)` show no badge at all.
 */
const pending: ApprovalRow[] = [
  {
    id: "apr_8f2k",
    agentSlug: "claude",
    appSlug: "home",
    tool: "set_scene",
    args: { scene: "movie_night" },
    status: "pending",
    createdAt: "2026-08-24T14:29:55.000Z",
    decidedAt: null,
    expiresAt: "2026-08-24T15:29:55.000Z",
  },
  {
    id: "apr_3d7m",
    agentSlug: "cron",
    appSlug: "notion",
    tool: "create_page",
    args: { title: "Weekly report", parent: "Reports", credentials: { token: "‹redacted›" } },
    status: "pending",
    decidedAt: null,
    createdAt: "2026-08-24T14:12:31.000Z",
    expiresAt: "2026-08-24T15:12:31.000Z",
  },
];

/** The three reads `/apps` mounts: its own listing, the tokens the delete dialog counts,
 *  and the pending set the shell's badge counts. `approvals` is a parameter because two
 *  states render a namespace with nothing pending. */
const reads = (apps: AppRow[], approvals: ApprovalRow[] = pending): Seed["queries"] => [
  { key: keys.apps(), data: { apps } },
  { key: keys.tokens(), data: { tokens } },
  { key: keys.approvalsPending(), data: { approvals } },
];

/** The full board, as every populated state holds it: the six active rows and the one
 *  archived one, in `app_list`'s order — the client holds ONE list and splits it on
 *  `archived`, where the props carried two. */
const board = [news, notion, linear, github, slack, weather, home];

/* ---------------------------------- /apps --------------------------------- */

/**
 * Every state of `/apps`, keyed exactly as `server/dev/fixtures.ts`' `apps` keys them.
 *
 * The two flash states are search parameters rather than a seeded notice, because that is
 * how the notice reaches the client: the server's redirect-back writes `NOTICE_KEYS` into
 * the URL and `chrome/Notice`'s `useFlash` reads them back out.
 */
export const appsSeeds: Record<string, Seed> = {
  /** Both kinds, every status a row can be in, and the archived section under them. */
  default: {
    path: "/apps",
    queries: reads(board),
  },

  /** A namespace with nothing in it yet: the empty card, and no nav badge. */
  empty: {
    path: "/apps",
    queries: reads([], []),
  },

  /** Nothing live, everything parked — the archived section carrying the page alone. */
  allArchived: {
    path: "/apps",
    queries: reads([home, { ...weather, archived: true }], []),
  },

  /** The Delete dialog open on `news`, whose copy names the two tokens it revokes. */
  confirmDelete: {
    path: "/apps",
    search: { confirm: "delete", slug: "news" },
    queries: reads(board),
  },

  /** A Connect attempt that came back from the provider with no credential — the danger
   *  banner `POST /apps/connect`'s refusal arm redirects back with. */
  connectFailed: {
    path: "/apps",
    search: {
      failed: "connect",
      reason: "The provider did not complete the sign-in. Nothing was stored — try Reconnect.",
    },
    queries: reads(board),
  },

  /** The success banner after archiving `home`, with the board already missing it. */
  archivedNotice: {
    path: "/apps",
    search: { done: "app_archive" },
    queries: reads([news, notion, linear, github, slack, home]),
  },

  /** Names, slugs, endpoints and role lists past every column's comfort. */
  longData: {
    path: "/apps",
    queries: reads([longRow, news]),
  },
};

/* -------------------------------- /apps/new ------------------------------- */

/** The token `fixtures.ts` shows in its reveal state: obviously fake, and shaped like the
 *  real thing so the layout is honest. */
const FAKE_APP_TOKEN = "pmcp_app_FAKE0000000000000000000000000000000000";

/**
 * A refusal as `POST /api/hub/apps` answers it. `reason` is not free copy: `admin.ts`'s
 * `refusedWith` builds it by joining the violations' own sentences with `"; "`, so
 * computing it here is what keeps the seeded refusal the shape a real one has.
 */
const refusal = (...violations: Violation[]): { reason: string; violations: Violation[] } => ({
  reason: violations.map((violation) => violation.reason).join("; "),
  violations,
});

/**
 * Every state of `/apps/new`, keyed exactly as `server/dev/fixtures.ts`' `appNew` keys
 * them. `queries` is empty on all ten: the page is chromeless — no shell, no badge — and
 * its whole content is the draft, which it reads from the URL.
 *
 * The prefilled forms are therefore SEARCH parameters, spelled as `derive.ts`'s
 * `appNewDraft` reads them, and the three refusals and three receipts are transient,
 * because each is the outcome of a submit the gallery cannot perform.
 */
export const appNewSeeds: Record<string, Seed> = {
  /** The artboard's state: a proxied app about to be OAuth-connected. */
  default: {
    path: "/apps/new",
    search: {
      kind: "proxy",
      name: "Linear",
      slug: "linear",
      endpoint: "https://mcp.linear.app/mcp",
      authMode: "oauth",
    },
    queries: [],
  },

  /** The tunneled half: no endpoint and no auth mode, and the token note under the fields. */
  tunneled: {
    path: "/apps/new",
    search: { kind: "tunnel", name: "News MCP", slug: "news" },
    queries: [],
  },

  /** An untouched form — the first thing "Add app" shows. */
  blank: {
    path: "/apps/new",
    queries: [],
  },

  /** The reserved builtin slug, refused under the Slug control in the op's own words. */
  slugReserved: {
    path: "/apps/new",
    search: { kind: "tunnel", name: "PMCP", slug: "pmcp" },
    queries: [],
    transient: {
      refusal: refusal({
        field: "slug",
        reason: `the slug "pmcp" is reserved for the builtin admin app`,
      }),
    },
  },

  /** A slug outside `[a-z0-9-]`, refused by the schema's own coercion before any rule. */
  slugInvalid: {
    path: "/apps/new",
    search: { kind: "tunnel", name: "News Feed", slug: "News_Feed" },
    queries: [],
    transient: {
      refusal: refusal({ field: "slug", reason: `"slug" is not a valid slug` }),
    },
  },

  /** Three violations at once, one of them naming no control of the form and therefore
   *  drawn as the whole-form message. */
  errors: {
    path: "/apps/new",
    search: { kind: "proxy", slug: "notion", endpoint: "mcp.notion.com" },
    queries: [],
    transient: {
      refusal: refusal(
        { field: "slug", reason: `"slug" already exists in this namespace` },
        {
          field: "endpoint",
          reason: `"endpoint" must be an https:// URL (http:// only for localhost)`,
        },
        { field: "roles", reason: `role name "all" is reserved` },
      ),
    },
  },

  /** The `auth: oauth` receipt: the app exists and the owner clicks through to the
   *  provider — a link, never an auto-open. */
  connecting: {
    path: "/apps/new",
    queries: [],
    transient: {
      connecting: {
        slug: "linear",
        name: "Linear",
        authorizeUrl:
          "https://linear.app/oauth/authorize?client_id=https%3A%2F%2Fmcp.example.com%2Fclient&state=FAKE0000-state",
      },
    },
  },

  /** The one render that holds a tunneled app's plaintext key. */
  tokenReveal: {
    path: "/apps/new",
    queries: [],
    transient: { created: { slug: "news", name: "News MCP", token: FAKE_APP_TOKEN } },
  },

  /** A proxied app has nothing that dials in, so the same receipt comes one card lighter. */
  createdProxy: {
    path: "/apps/new",
    queries: [],
    transient: { created: { slug: "notion", name: "Notion", token: null } },
  },

  /** The slug helper line wrapping around a very long name, slug and endpoint. */
  longValues: {
    path: "/apps/new",
    search: {
      kind: "proxy",
      name: "Internal observability and incident response toolkit (staging mirror)",
      slug: "internal-observability-and-incident-response-toolkit",
      endpoint:
        "https://mcp.internal.example.com/observability/incident-response/v2/streamable-http?tenant=staging-mirror",
      authMode: "oauth",
    },
    queries: [],
  },
};
