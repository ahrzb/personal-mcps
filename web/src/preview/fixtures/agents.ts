/**
 * Every state of `/agents`, `/agents/new` and `/agents/<slug>`, as the gallery reproduces
 * them — the React half of the server fixtures' (`../seed.ts`) `agents`, `agentNew` and
 * `agentDetail`.
 *
 * The state NAMES are the SSR fixture names one for one, because `visual-compare.mts` pairs a
 * screenshot with its baseline by filename.
 *
 * One difference in kind from the SSR fixtures, and it is the reason this file is long: those
 * were PROPS — the output of `model.ts`' derivations, written by hand — and these are the
 * WIRE, the input those derivations run on. So the numbers here are not copied from the
 * fixtures; they are the data that makes the client compute them. Where the hand-written
 * props were internally inconsistent (a rail claiming `Apps · 3` beside a header claiming six
 * granted entries when its own panes spell seven, a `matches 5` beside a catalog holding
 * three matches), no wire state can reproduce both, and this file reproduces the PANES — the
 * rows, the copy and the structure — and lets the derived counts be what the data says.
 * `docs/` has the list; the report that landed with this file names each one.
 *
 * Shared bulk lives in consts at the top: one apps list, one agent set, one catalog per app,
 * and per-state overrides built from them by `withAgents` / `withApps`.
 */

import { keys } from "@/lib/queries";
import type {
  AppRow,
  ApprovalRow,
  AuditRow,
  CatalogDerivation,
  ConnectionRow,
  ListedAgent,
  ListedItem,
  RenderedProse,
  TokenInfo,
} from "@/lib/types";
import type { Seed } from "../seed";

/** Epoch milliseconds from a readable instant — registry and audit spell time this way. */
const ms = (iso: string): number => Date.parse(iso);

/** The instant every state renders at (the server fixtures' own `NOW`): 17 minutes after
 *  the oldest pending approval. The preview clock is frozen here, so `12m ago` is stable. */
const NOW = ms("2026-08-24T14:47:00.000Z");

const HOUR = 60 * 60 * 1000;

/* ------------------------------------------------------------------ prose --- */

/**
 * One description as the hub's renderer answers it. Written out rather than derived, because
 * the three forms are `pages/markdown.ts`' OUTPUT and the browser holds no renderer: a seed
 * that computed them would be the second implementation that module forbids.
 */
const prose = (text: string, inline: string, block: string): RenderedProse => ({ inline, block, text });

/** The common case: prose with no markup in it at all. */
const plain = (text: string): RenderedProse => prose(text, text, `<p>${text}</p>`);

/** One tool, prompt or resource's derivation. Only `description` and `arguments` are drawn by
 *  the agent page, so the schema halves are empty rather than invented. */
function derivedOf(
  subject: string,
  description: RenderedProse,
  args: CatalogDerivation["arguments"] = [],
): CatalogDerivation {
  return {
    subject,
    description,
    arguments: args,
    argPaths: [],
    resultPaths: [],
    writeOnly: [],
    promptArguments: [],
  };
}

/* ------------------------------------------------------------------- apps --- */

const newsRoles = {
  reader: { tools: ["get_news", "search_.*"], prompts: ["digest_.*"] },
  admin: { tools: ["admin_.*"] },
  publisher: { tools: ["publish", "delete_feed"] },
};

/** `News MCP` — the tunneled app every app-pane state is drawn against. */
const news: AppRow = {
  slug: "news",
  name: "News MCP",
  description: "Feeds, items and the odd secret push.",
  kind: "tunnel",
  archived: false,
  status: "online",
  lastSeen: ms("2026-08-24T14:41:00.000Z"),
  logBodies: true,
  roles: newsRoles,
  ownerRoles: {},
  redact: {},
  redactResults: {},
  typescriptAliases: {},
  typescriptReservations: [
    { appId: "app_news", family: "service", canonicalName: "news", typescriptName: "news", source: "generated", active: true },
    { appId: "app_news", family: "tool", canonicalName: "get_news", typescriptName: "getNews", source: "generated", active: true },
  ],
  typescriptDiagnostics: [],
  createdAt: ms("2026-07-02T11:00:00.000Z"),
};

/** A second granted app, so the rail has more than one and the Activity rows have two apps
 *  to name. */
const linear: AppRow = {
  slug: "linear",
  name: "Linear",
  description: "Issues and cycles over the Linear MCP.",
  kind: "proxy",
  archived: false,
  endpoint: "https://mcp.linear.app/sse",
  auth: "oauth",
  connection: "connected",
  forwardIdentity: false,
  capabilities: ["tools"],
  logBodies: false,
  roles: { reader: { tools: ["list_issues", "get_issue"] } },
  redact: {},
  redactResults: {},
  typescriptAliases: {},
  typescriptReservations: [],
  typescriptDiagnostics: [],
  createdAt: ms("2026-07-19T09:30:00.000Z"),
};

/** The archived, never-connected one: the rail's dimmed entry and the `unconnected` pane. */
const home: AppRow = {
  slug: "home",
  name: "Home Assistant",
  description: "Lights, locks and the thermostat.",
  kind: "tunnel",
  archived: true,
  status: "offline",
  lastSeen: null,
  logBodies: true,
  roles: {},
  ownerRoles: {},
  redact: {},
  redactResults: {},
  typescriptAliases: {},
  typescriptReservations: [],
  typescriptDiagnostics: [],
  createdAt: ms("2026-06-11T18:00:00.000Z"),
};

/** The grantable one: claude holds nothing on it, which is what the grant step lists. */
const gh: AppRow = {
  slug: "gh",
  name: "GitHub",
  description: "Repositories, pull requests and issues over the GitHub MCP",
  kind: "proxy",
  archived: false,
  endpoint: "https://api.githubcopilot.com/mcp/",
  auth: "oauth",
  connection: "connected",
  forwardIdentity: false,
  capabilities: ["tools"],
  logBodies: true,
  roles: { reader: { tools: ["list_prs", "get_pr"] } },
  redact: {},
  redactResults: {},
  typescriptAliases: {},
  typescriptReservations: [],
  typescriptDiagnostics: [],
  createdAt: ms("2026-08-01T08:15:00.000Z"),
};

/** The 40-character slug, as its own app: the width the framed rail ellipsizes at. */
const LONG_SLUG = "incident-response-and-postmortem-runners";

/** The same 40 characters as a tool name — one token, so it cannot wrap at a hyphen. */
const LONG_TOOL = "search_incident_timeline_across_services";

/** A 300-character pattern, in a role's detail line. */
const LONG_PATTERN =
  "incident_(?:timeline|summary|postmortem|rollup|digest|handover|escalation|acknowledge|" +
  "silence|reopen|annotate|link_change|link_deploy|link_alert|assign_commander|" +
  "assign_scribe|page_oncall|page_backup|declare|downgrade|upgrade|resolve|verify|" +
  "publish_status|retract_status|snapshot_states)_(?:v1|v2|v3)";

/** A 40-word description: what an app that documents itself in prose actually publishes. */
const LONG_DESCRIPTION =
  "Search the incident timeline across every connected service and return the matching " +
  "events in order, with the deploy, alert and chat messages that surround each one, so " +
  "an on-call responder can reconstruct what happened without opening four consoles " +
  "by hand.";

/** The long-data app. Its NAME is deliberately short: this state's long strings are the
 *  three the SSR fixture names — the 300-character pattern, the 40-word description and the
 *  40-character slug in the rail — and a long display name would add a fourth the state was
 *  never about. */
const longApp: AppRow = {
  ...news,
  slug: LONG_SLUG,
  name: "Incident response",
  description: LONG_DESCRIPTION,
  roles: { "incident-responder": { tools: [LONG_PATTERN] } },
  typescriptReservations: [
    { appId: "app_long", family: "service", canonicalName: LONG_SLUG, typescriptName: "incidentResponse", source: "generated", active: true },
    { appId: "app_long", family: "tool", canonicalName: LONG_TOOL, typescriptName: "searchIncidentTimeline", source: "generated", active: true },
  ],
};

const apps: AppRow[] = [news, linear, home, gh];

/* ----------------------------------------------------------------- agents --- */

/** claude's set on `news`: three allowed and two ask-first, which is what the app pane's
 *  `saved · 3 allow · 2 ask` line counts and what every row's implied mode is read from. */
const NEWS_GRANT = ["reader", "tool/get_news", "resource/news://feed/*", "admin:approval", "tool/publish:approval"];

const claude: ListedAgent = {
  slug: "claude",
  name: "Claude",
  description: "Claude sessions",
  createdAt: ms("2026-08-12T09:00:00.000Z"),
  grants: { news: NEWS_GRANT, linear: ["reader"], home: ["lights:approval"] },
};

const cron: ListedAgent = {
  slug: "cron",
  name: "cron",
  description: "Scheduled jobs",
  createdAt: ms("2026-08-20T16:05:00.000Z"),
  grants: { news: ["reader"] },
};

/** The third row: an identity holding nothing at all, so the list shows `no grants`. */
const pi: ListedAgent = {
  slug: "pi",
  name: "pi",
  description: "Raspberry Pi runner",
  createdAt: ms("2026-09-01T08:00:00.000Z"),
  grants: {},
};

const agents: ListedAgent[] = [claude, cron, pi];

/* --------------------------------------------------------------- the keys --- */

const appsQuery = { key: keys.apps(), data: { apps } };
const agentsQuery = { key: keys.agents(), data: { agents } };

const connections: ConnectionRow[] = [
  {
    id: "conn_9f2a",
    clientId: "claude-ai",
    clientName: "Claude",
    agentSlug: "claude",
    createdAt: ms("2026-08-14T10:00:00.000Z"),
    lastUsedAt: ms("2026-08-24T12:47:00.000Z"),
    revokedAt: null,
    redirectOrigin: "https://claude.ai",
    selfRegistered: false,
  },
];

/** claude's live key: the one the reveal, the `new` badge and the Revoke dialog are about. */
const liveToken: TokenInfo = {
  id: "tok_4kJk9fQ",
  kind: "agent",
  refId: "agt_claude",
  refSlug: "claude",
  prefix: "pmcp_agt_4kJk…9fQ",
  createdAt: ms("2026-08-12T09:00:00.000Z"),
  expiresAt: ms("2026-11-10T09:00:00.000Z"),
  lastUsedAt: ms("2026-08-24T12:47:00.000Z"),
  revokedAt: null,
};

/** …and the one already past its date, which stays listed and reads `Remove`. */
const expiredToken: TokenInfo = {
  id: "tok_2mQv8xT",
  kind: "agent",
  refId: "agt_claude",
  refSlug: "claude",
  prefix: "pmcp_agt_2mQv…8xT",
  createdAt: ms("2026-05-14T09:00:00.000Z"),
  expiresAt: ms("2026-08-12T09:00:00.000Z"),
  lastUsedAt: ms("2026-07-30T18:20:00.000Z"),
  revokedAt: null,
};

/** The whole namespace's credentials: the client filters by kind and slug, so cron's key
 *  rides along and proves it does. */
const tokens: TokenInfo[] = [
  liveToken,
  expiredToken,
  {
    id: "tok_7hRt2wZ",
    kind: "agent",
    refId: "agt_cron",
    refSlug: "cron",
    prefix: "pmcp_agt_7hRt…2wZ",
    createdAt: ms("2026-08-20T16:05:00.000Z"),
    expiresAt: ms("2026-11-18T16:05:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
  },
];

const tokensQuery = { key: keys.tokens(), data: { tokens } };

/** The two requests still waiting — the rail's Activity marker and the pane's own heading. */
const pendingApprovals: ApprovalRow[] = [
  {
    id: "apr_01",
    agentSlug: "claude",
    appSlug: "news",
    tool: "admin_purge_cache",
    args: { scope: "feeds", older_than: "7d" },
    status: "pending",
    createdAt: "2026-08-24T14:35:00.000Z",
    decidedAt: null,
    expiresAt: "2026-08-24T15:35:00.000Z",
  },
  {
    id: "apr_02",
    agentSlug: "claude",
    appSlug: "news",
    tool: "admin_reindex",
    args: { feed: "hn" },
    status: "pending",
    createdAt: "2026-08-24T14:06:00.000Z",
    decidedAt: null,
    expiresAt: "2026-08-24T15:06:00.000Z",
  },
];

/** …and the one decided a moment ago, which the Activity pane keeps listed, dimmed and
 *  badged: a decision that vanished would read as the request having vanished. */
const decidedApproval: ApprovalRow = {
  id: "apr_03",
  agentSlug: "claude",
  appSlug: "linear",
  tool: "close_issue",
  args: { id: "ENG-41" },
  status: "approved",
  createdAt: "2026-08-24T13:12:00.000Z",
  decidedAt: "2026-08-24T13:20:00.000Z",
  expiresAt: "2026-08-24T14:12:00.000Z",
};

const pendingQuery = { key: keys.approvalsPending(), data: { approvals: pendingApprovals } };
const historyQuery = {
  key: keys.approvalsHistory(50),
  data: { approvals: [...pendingApprovals, decidedApproval] },
};

/* --------------------------------------------------------------- catalogs --- */

const newsTools: ListedItem[] = [
  { name: "get_news", description: "Latest items across **all** feeds", inputSchema: {} },
  { name: "search_feeds", description: "Find feeds by name or URL", inputSchema: {} },
  { name: "admin_purge_cache", description: "Drop cached items", inputSchema: {} },
  { name: "publish", description: "Post an item to a feed", inputSchema: {} },
  { name: "subscribe", description: "Subscribe to a feed", inputSchema: {} },
];

const newsToolsDerived: CatalogDerivation[] = [
  derivedOf(
    "get_news",
    prose(
      "Latest items across all feeds.",
      "Latest items across <strong>all</strong> feeds.",
      '<p>Latest items across <strong>all</strong> feeds.</p>\n<p>Pass <code>since</code> to window it; the ordering rules are in the <a href="https://example.com/feeds" rel="noopener noreferrer" target="_blank">feed docs</a>.</p>\n<ul>\n<li>newest first</li>\n<li>capped at 50 items</li>\n</ul>',
    ),
    [{ name: "since", type: "string", required: false, hasDefault: false }],
  ),
  derivedOf("search_feeds", plain("Find feeds by name or URL")),
  derivedOf("admin_purge_cache", plain("Drop cached items")),
  derivedOf("publish", plain("Post an item to a feed")),
  derivedOf("subscribe", plain("Subscribe to a feed")),
];

const newsPrompts: ListedItem[] = [{ name: "digest_daily", description: "Summarise the last 24 h" }];
const newsPromptsDerived = [derivedOf("digest_daily", plain("Summarise the last 24 h"))];

const newsResources: ListedItem[] = [
  { uri: "news://feed/hn", name: "Hacker News", mimeType: "text/plain" },
  { uri: "news://config", name: "Configuration", mimeType: "application/json" },
];
// A resource's line is its MEDIA TYPE, not prose — the derivation still carries the
// declaration's own description, which this family's rows never draw.
const newsResourcesDerived = [
  derivedOf("news://feed/hn", plain("The Hacker News front page, as items.")),
  derivedOf("news://config", plain("The app's own configuration.")),
];

const ghTools: ListedItem[] = [
  { name: "list_prs", description: "Open pull requests", inputSchema: {} },
  { name: "get_pr", description: "One pull request", inputSchema: {} },
  { name: "merge_pr", description: "Merge a pull request", inputSchema: {} },
  { name: "create_issue", description: "Open an issue", inputSchema: {} },
];

const ghToolsDerived = [
  derivedOf("list_prs", plain("Open pull requests")),
  derivedOf("get_pr", plain("One pull request")),
  derivedOf("merge_pr", plain("Merge a pull request")),
  derivedOf("create_issue", plain("Open an issue")),
];

/** One app's four catalog entries. `resourceTemplates` is always present and usually empty:
 *  it is a separate read and the editor joins it into the resources family. */
function catalogQueries(
  slug: string,
  families: {
    tools?: { items: ListedItem[]; derived: CatalogDerivation[] };
    prompts?: { items: ListedItem[]; derived: CatalogDerivation[] };
    resources?: { items: ListedItem[]; derived: CatalogDerivation[] };
  },
): Seed["queries"] {
  const empty = { items: [], derived: [] };
  const tools = families.tools ?? empty;
  const prompts = families.prompts ?? empty;
  const resources = families.resources ?? empty;
  return [
    { key: keys.appCatalogFamily(slug, "tools"), data: { family: "tools", ...tools } },
    { key: keys.appCatalogFamily(slug, "prompts"), data: { family: "prompts", ...prompts } },
    { key: keys.appCatalogFamily(slug, "resources"), data: { family: "resources", ...resources } },
    { key: keys.appCatalogFamily(slug, "resourceTemplates"), data: { family: "resourceTemplates", ...empty } },
  ];
}

/** One app's own resource, as the app pane reads it: the row, the addressing kind, and
 *  §23.6's rendered diagnostics (none of these apps has one). */
function appQueries(row: AppRow): Seed["queries"] {
  return [
    {
      key: keys.app(row.slug),
      data: { app: row, kind: row.kind, diagnostics: [] },
    },
  ];
}

const newsCatalog: Seed["queries"] = [
  { key: keys.appCapabilities("news"), data: { capabilities: ["tools", "prompts", "resources"], neverConnected: false } },
  ...catalogQueries("news", {
    tools: { items: newsTools, derived: newsToolsDerived },
    prompts: { items: newsPrompts, derived: newsPromptsDerived },
    resources: { items: newsResources, derived: newsResourcesDerived },
  }),
];

const ghCatalog: Seed["queries"] = [
  { key: keys.appCapabilities("gh"), data: { capabilities: ["tools"], neverConnected: false } },
  ...catalogQueries("gh", { tools: { items: ghTools, derived: ghToolsDerived } }),
];

/** A tunneled app that has never connected has NO catalog at all — not an empty one — so the
 *  four family reads are never issued and none is seeded. */
const homeCatalog: Seed["queries"] = [
  { key: keys.appCapabilities("home"), data: { capabilities: ["tools"], neverConnected: true } },
];

/* ------------------------------------------------------------- the ledger --- */

/** One `tools/call` row, as `audit_query` reports it. */
function call(
  id: number,
  app: string,
  tool: string,
  at: string,
  durationMs: number,
  outcome: string,
  bodies?: { args?: Record<string, unknown>; result?: Record<string, unknown> },
): AuditRow {
  return {
    id,
    ts: ms(at),
    ownerId: "own_ahrzb",
    principal: "agent:claude",
    event: "tools/call",
    app,
    tool,
    outcome,
    durationMs,
    ...(bodies?.args === undefined ? {} : { args: bodies.args }),
    ...(bodies?.result === undefined ? {} : { result: bodies.result }),
  };
}

const recentCalls: AuditRow[] = [
  call(4101, "linear", "list_issues", "2026-08-24T12:47:00.000Z", 412, "ok"),
  call(4102, "news", "search_items", "2026-08-24T12:40:00.000Z", 88, "ok", {
    args: { query: "cloudflare outage", cookie: "‹redacted›" },
    result: { items: [{ id: "hn-1", title: "Cloudflare restores service" }] },
  }),
  // A refusal carries no bodies, whatever the app's setting — which is why the details column
  // says `Refused before the call was made` rather than showing an empty card.
  call(4103, "news", "admin_purge_cache", "2026-08-24T11:47:00.000Z", 6, "-32003"),
];

/** A full page of the walk: twenty rows, so the Load-more foot has a page to sit under. */
const pagedCalls: AuditRow[] = Array.from({ length: 20 }, (_unused, index) =>
  call(
    4200 + index,
    index % 3 === 0 ? "linear" : "news",
    index % 3 === 0 ? "list_issues" : "search_items",
    new Date(ms("2026-08-24T12:40:00.000Z") - index * HOUR).toISOString(),
    40 + index,
    "ok",
  ),
);

/** The Activity pane's own read: this agent's calls in §15's window, one page at a time. */
function callsQuery(limit: number, rows: AuditRow[], total: number): Seed["queries"][number] {
  return {
    key: keys.audit({ principal: "agent:claude", event: "tools/call", range: "7d", limit: String(limit) }),
    data: {
      filters: {
        since: NOW - 7 * 24 * HOUR,
        until: NOW,
        range: "7d",
        principal: "agent:claude",
        event: "tools/call",
        limit,
        offset: 0,
      },
      page: { rows, total },
    },
  };
}

/** The selected key's Recent-use card: the same ledger, the widest window, three rows. */
function recentUseQuery(rows: AuditRow[]): Seed["queries"][number] {
  return {
    key: keys.audit({ principal: "agent:claude", event: "tools/call", range: "30d", limit: "3" }),
    data: {
      filters: {
        since: NOW - 30 * 24 * HOUR,
        until: NOW,
        range: "30d",
        principal: "agent:claude",
        event: "tools/call",
        limit: 3,
        offset: 0,
      },
      page: { rows, total: rows.length },
    },
  };
}

/* ------------------------------------------------------------------ /agents --- */

const listQueries: Seed["queries"] = [agentsQuery, appsQuery, tokensQuery, pendingQuery];

export const agentsSeeds: Record<string, Seed> = {
  /** The artboard: three agents — one rich, one narrow, one holding nothing at all. */
  default: { queries: listQueries, path: "/agents" },
  /** A fresh namespace: the empty state and its New agent control. */
  empty: {
    queries: [
      { key: keys.agents(), data: { agents: [] } },
      appsQuery,
      { key: keys.tokens(), data: { tokens: [] } },
      { key: keys.approvalsPending(), data: { approvals: [] } },
    ],
    path: "/agents",
  },
  /** Delete, confirming — the list's own URL-addressed dialog. */
  confirmDelete: {
    queries: listQueries,
    path: "/agents",
    search: { confirm: "delete-agent", slug: "claude" },
  },
  /** The long-data check: a 40-character slug and a 40-word description in the row the board
   *  draws at six words, beside the short rows they have to stay aligned with. */
  longData: {
    queries: [
      {
        key: keys.agents(),
        data: {
          agents: [
            {
              slug: LONG_SLUG,
              name: "Incident response and postmortem runners (staging)",
              description: LONG_DESCRIPTION,
              createdAt: ms("2026-08-12T09:00:00.000Z"),
              grants: { news: NEWS_GRANT, linear: ["reader"], home: ["lights:approval"] },
            },
            ...agents,
          ],
        },
      },
      appsQuery,
      {
        key: keys.tokens(),
        data: {
          tokens: [
            ...tokens,
            { ...liveToken, id: "tok_long", refId: "agt_long", refSlug: LONG_SLUG },
          ],
        },
      },
      pendingQuery,
    ],
    path: "/agents",
  },
};

/* -------------------------------------------------------------- /agents/new --- */

export const agentNewSeeds: Record<string, Seed> = {
  /** The three fields and nothing else. */
  default: { queries: [pendingQuery], path: "/agents/new" },
  /** A refused slug, the reason under the field it names. */
  refused: {
    queries: [pendingQuery],
    path: "/agents/new",
    search: { slug: "new" },
    transient: { refusal: { reason: 'the slug "new" is reserved: /agents/new is a page' } },
  },
};

/* ----------------------------------------------------------- /agents/<slug> --- */

/** What every pane of the agent page reads: the agent, the apps, the keys and the pending
 *  set — the four that fill the header and the rail on every state. */
const pageQueries: Seed["queries"] = [
  { key: keys.agent("claude"), data: { agent: claude, agents, connections } },
  appsQuery,
  tokensQuery,
  pendingQuery,
];

/** …with claude holding a different set, for the states that are about the set itself. */
function pageWith(grants: ListedAgent["grants"], appList: AppRow[] = apps): Seed["queries"] {
  const agent = { ...claude, grants };
  return [
    { key: keys.agent("claude"), data: { agent, agents: [agent, cron, pi], connections } },
    { key: keys.apps(), data: { apps: appList } },
    tokensQuery,
    pendingQuery,
  ];
}

/** The app pane's own reads, for one app. */
const newsPane: Seed["queries"] = [...pageQueries, ...appQueries(news), ...newsCatalog];

const NEWS_PATH = "/agents/claude/apps/news";
const GRANT_PATH = "/agents/claude/grant";
const CREDENTIALS_PATH = "/agents/claude/credentials";
const ACTIVITY_PATH = "/agents/claude/activity";

export const agentDetailSeeds: Record<string, Seed> = {
  /** The artboard: the `news` pane with `get_news` selected, reached through `reader`. */
  default: { queries: newsPane, path: NEWS_PATH, search: { sel: "tool:get_news" } },

  /** A role selected: its patterns, what they match today, and the widening note. */
  roleSelected: { queries: newsPane, path: NEWS_PATH, search: { sel: "role:reader" } },
  /** A pattern entry selected: what it matches today, by name. */
  patternSelected: {
    queries: newsPane,
    path: NEWS_PATH,
    search: { sel: "pattern:resource/news://feed/*" },
  },
  /** A resource selected: no arguments and no TypeScript path, but the same reach facts. */
  resourceSelected: { queries: newsPane, path: NEWS_PATH, search: { sel: "resource:news://config" } },

  /** Typed text that is not one name: offered as a pattern entry, with Ask / Allow. */
  filterOffer: { queries: newsPane, path: NEWS_PATH, search: { q: "admin_*" } },
  /** A filter nothing answers: the patterns stay, everything else goes. */
  filterNothing: { queries: newsPane, path: NEWS_PATH, search: { q: "zzz" } },

  /** Straight after Grant on the grant step: an empty set, the dashed badge. */
  newGrant: {
    queries: [...pageQueries, ...appQueries(gh), ...ghCatalog],
    path: "/agents/claude/apps/gh",
  },
  /** Remove from claude, confirming: the dialog whose Save clears the whole set. `sel` rides
   *  along because the dialog is opened from a pane that had a row selected — which is also
   *  the narrow level the SSR fixture drew it at. */
  confirmRemove: {
    queries: newsPane,
    path: NEWS_PATH,
    search: { sel: "tool:get_news", confirm: "remove-app" },
  },

  /** A held role the app has not declared: kept, badged, removable by its own ×. */
  undeclaredRole: {
    queries: [
      ...pageWith({ news: [...NEWS_GRANT, "editor"], linear: ["reader"], home: ["lights:approval"] }),
      ...appQueries(news),
      ...newsCatalog,
    ],
    path: NEWS_PATH,
  },
  /** A direct ask under a role that allows: allow wins, so the entry is badged rather than
   *  dropped — it is the owner's, and only they should remove it. */
  noEffect: {
    queries: [
      ...pageWith({
        news: ["reader", "tool/get_news:approval", "resource/news://feed/*", "admin:approval", "tool/publish:approval"],
        linear: ["reader"],
        home: ["lights:approval"],
      }),
      ...appQueries(news),
      ...newsCatalog,
    ],
    path: NEWS_PATH,
  },
  /** A tunneled app that has never connected: one note line in place of every family. */
  unconnected: {
    queries: [...pageQueries, ...appQueries(home), ...homeCatalog],
    path: "/agents/claude/apps/home",
  },
  /** A refused save: the reason above the listing, the owner's own choices still there. */
  refused: {
    queries: newsPane,
    path: NEWS_PATH,
    transient: { refusal: { reason: '"roles" entry "tool/(" is not a valid pattern' } },
  },

  /** The grant step: one card per active app the agent holds nothing on, closed — a closed
   *  card has read no catalog, which is why its line offers to fetch one. */
  grant: { queries: pageQueries, path: GRANT_PATH },
  /** `?show=gh`: the endpoint list and the roles that grant each one. */
  grantShowAll: {
    queries: [...pageQueries, ...catalogQueries("gh", { tools: { items: ghTools, derived: ghToolsDerived } })],
    path: GRANT_PATH,
    search: { show: "gh" },
  },
  /** A search that matched inside a card: it opens, showing only what matched. */
  grantSearch: {
    queries: [...pageQueries, ...catalogQueries("gh", { tools: { items: ghTools, derived: ghToolsDerived } })],
    path: GRANT_PATH,
    search: { q: "merge" },
  },
  /** Every active app already granted: the sentence, and no card at all. Reached by shelving
   *  the one grantable app, because an archived app is not offered — unarchive one to grant
   *  it, which is exactly what the sentence says. */
  grantEverywhere: {
    queries: [
      { key: keys.agent("claude"), data: { agent: claude, agents, connections } },
      { key: keys.apps(), data: { apps: [news, linear, home, { ...gh, archived: true }] } },
      tokensQuery,
      pendingQuery,
    ],
    path: GRANT_PATH,
  },

  /** Credentials with nothing selected: the summary card. */
  credentials: { queries: pageQueries, path: CREDENTIALS_PATH },
  /** A live key selected: what it carries, and the agent's own recent calls. */
  credentialsTokenSelected: {
    queries: [...pageQueries, recentUseQuery(recentCalls)],
    path: CREDENTIALS_PATH,
    search: { sel: "token:tok_4kJk9fQ" },
  },
  /** An expired key selected: the row's verb reads Remove, not Revoke. */
  credentialsExpiredSelected: {
    queries: [...pageQueries, recentUseQuery([])],
    path: CREDENTIALS_PATH,
    search: { sel: "token:tok_2mQv8xT" },
  },
  /** The OAuth client selected: read-only, pointing at the pane that revokes. */
  credentialsClientSelected: {
    queries: pageQueries,
    path: CREDENTIALS_PATH,
    search: { sel: "client:conn_9f2a" },
  },
  /** Right after Issue token: the once-only reveal, and the row it belongs to marked `new`.
   *  Both come from one seed, because one mint draws both. */
  credentialsIssued: {
    queries: pageQueries,
    path: CREDENTIALS_PATH,
    transient: {
      revealedToken: { token: "pmcp_agt_7QmFAKE0000000000000000000000000000", id: "tok_4kJk9fQ" },
    },
  },
  /** Revoke, confirming. */
  credentialsConfirmRevoke: {
    queries: pageQueries,
    path: CREDENTIALS_PATH,
    search: { confirm: "revoke-token", id: "tok_4kJk9fQ" },
  },
  /** Remove, on the expired one — the same op, said the way an expired key deserves. */
  credentialsConfirmRemoveExpired: {
    queries: pageQueries,
    path: CREDENTIALS_PATH,
    search: { confirm: "remove-token", id: "tok_2mQv8xT" },
  },

  /** Activity with nothing selected: the seven-day summary. */
  activity: {
    queries: [...pageQueries, historyQuery, callsQuery(20, recentCalls, recentCalls.length)],
    path: ACTIVITY_PATH,
  },
  /** A waiting request selected: its arguments, why it waits, and the two buttons. */
  activityApprovalSelected: {
    queries: [...pageQueries, historyQuery, callsQuery(20, recentCalls, recentCalls.length)],
    path: ACTIVITY_PATH,
    search: { sel: "approval:apr_01" },
  },
  /** A call that ran: arguments and result, both post-redaction. */
  activityCallOk: {
    queries: [...pageQueries, historyQuery, callsQuery(20, recentCalls, recentCalls.length)],
    path: ACTIVITY_PATH,
    search: { sel: "call:4102" },
  },
  /** A refused call: no bodies were ever recorded, and the pane says which of the three
   *  reasons it is. */
  activityCallRefused: {
    queries: [...pageQueries, historyQuery, callsQuery(20, recentCalls, recentCalls.length)],
    path: ACTIVITY_PATH,
    search: { sel: "call:4103" },
  },
  /** A full page with more behind it: the Load-more row and what it does not know. */
  activityPaged: {
    queries: [...pageQueries, historyQuery, callsQuery(20, pagedCalls, pagedCalls.length + recentCalls.length)],
    path: ACTIVITY_PATH,
    search: { calls: "20" },
  },
  /** The last page of a walked week: no link, and the sentence that says why. */
  activityEnd: {
    queries: [
      ...pageQueries,
      historyQuery,
      callsQuery(40, [...pagedCalls, ...recentCalls], pagedCalls.length + recentCalls.length),
    ],
    path: ACTIVITY_PATH,
    search: { calls: "40" },
  },

  /** The danger zone: the delete card, and what deletion removes. */
  danger: { queries: pageQueries, path: "/agents/claude/danger" },

  /* The three levels below the breakpoint. The SAME data, differing only in the URL each came
     from — which is the only thing that decides a level, and is why the attribute the narrow
     stylesheet reads is `data-level` and not a viewport test. */

  /** `/agents/claude` — the landing: the tiles and the rail as a full-width list. The bare
   *  URL is the only one that produces level 1, and it renders the first granted app's pane in
   *  place (slug order, so `home`). */
  narrowLevel1: {
    queries: [...pageQueries, ...appQueries(home), ...homeCatalog],
    path: "/agents/claude",
  },
  /** `/agents/claude/apps/news` — the listing alone, its header without the app's name. */
  narrowLevel2: { queries: newsPane, path: NEWS_PATH },
  /** `…/apps/news?sel=tool:get_news` — the details alone, `‹ News MCP` the way up. */
  narrowLevel3: { queries: newsPane, path: NEWS_PATH, search: { sel: "tool:get_news" } },

  /** The long-data check, all three strings at once: a 300-character pattern in a role's
   *  detail line, a 40-word description in a row AND in the details card, and a 40-character
   *  app slug in the framed rail. The page that shipped unlike its board did so because every
   *  fixture it was read against was short. */
  longData: {
    queries: [
      ...pageWith(
        { [LONG_SLUG]: ["incident-responder"], linear: ["reader"], home: ["lights:approval"] },
        [longApp, linear, home, gh],
      ),
      ...appQueries(longApp),
      {
        key: keys.appCapabilities(LONG_SLUG),
        data: { capabilities: ["tools"], neverConnected: false },
      },
      ...catalogQueries(LONG_SLUG, {
        tools: {
          items: [{ name: LONG_TOOL, description: LONG_DESCRIPTION, inputSchema: {} }],
          derived: [
            derivedOf(LONG_TOOL, plain(LONG_DESCRIPTION), [
              { name: "since", type: "string", required: false, hasDefault: false },
            ]),
          ],
        },
      }),
    ],
    path: `/agents/claude/apps/${LONG_SLUG}`,
    search: { sel: `tool:${LONG_TOOL}` },
  },
};
