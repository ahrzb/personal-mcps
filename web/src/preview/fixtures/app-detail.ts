import { CAPABILITY_OF_FAMILY } from "@/features/app-detail/derive";
import { keys } from "@/lib/queries";
import type {
  AliasDiagnostic,
  AliasReservation,
  AppResponse,
  AppRow,
  ArgumentRow,
  AuditResponse,
  AuditRow,
  CapabilitiesResponse,
  CatalogDerivation,
  CatalogFamily,
  CatalogResponse,
  ListedAgent,
  ListedItem,
  RenderedProse,
  RoleDeclaration,
  RolesResponse,
  SchemaLeaf,
  TokenInfo,
  TypescriptAliases,
} from "@/lib/types";
import { FROZEN_NOW } from "../clock";
import type { Seed } from "../seed";

/**
 * `/apps/<slug>` — all 47 states of the server fixtures' (`../seed.ts`) `appDetailFixtures`, one for
 * one by name, because each name is the filename its committed baseline carries and the
 * comparison pairs them by that string.
 *
 * The translation is the work. An SSR fixture is PAGE PROPS: a rail marker, a summary
 * sentence, a `matches 2`, a reach line — all of them already computed. A seed is the API
 * RESPONSES those props were computed FROM, so every one of those strings has to fall out of
 * the data rather than be written down. That is deliberate, and it is what makes the gallery
 * a demonstration rather than a picture: `familyMarker`, `reachabilityFor`, `matchCount`,
 * `tilesLine` and the pane summaries are the shipped functions here, running on seeded
 * answers.
 *
 * Three consequences worth knowing before editing anything below:
 *
 *  - ONE dataset per state has to satisfy every surface of that state at once. Where an SSR
 *    fixture typed two numbers no single map can produce — a role's listing detail and the
 *    same role's editor, an agent's reach line and the per-tool card — the data is chosen to
 *    keep the state that exists to SHOW the thing, and the divergence is recorded in the
 *    handoff rather than hidden behind a second copy of the value.
 *  - A family is seeded only where the page would ASK for it: `asks()` issues no request for
 *    a never-connected app and none for an undeclared family, which is what keeps `—`
 *    (advertises none) apart from `` (could not be read) apart from a count.
 *  - An unread family is the `error` channel — a 503 carrying `unread`. Empty data would draw
 *    a zero, and a zero is a fact where there is no fact.
 */

/** Epoch milliseconds from a readable instant, as the server fixtures' own `ms`. */
const ms = (iso: string): number => Date.parse(iso);

/** The instant the SSR fixtures render at, which the preview clock freezes to — so `last
 *  seen now`, `used now` and the call window are the same instants here. */
const NOW = FROZEN_NOW;

/** No description at all: three empty strings, never a `<p></p>`. */
const NO_PROSE: RenderedProse = { inline: "", block: "", text: "" };

/** Prose with no Markdown in it, in the three forms the hub's renderer produces: its own
 *  inline form, one paragraph as a block, and itself as text. The two Markdown-carrying
 *  descriptions below spell all three out, because a rendering is the renderer's output and
 *  not something to re-derive here. */
const plain = (text: string): RenderedProse =>
  text === "" ? NO_PROSE : { inline: text, block: `<p>${text}</p>\n`, text };

/** One row of §13's Arguments table — a schema property's columns, which carry no prose: a
 *  JSON Schema property has a type and a default, and only a PROMPT declares descriptions. */
const arg = (name: string, type: string, required: boolean): ArgumentRow => ({
  name,
  type,
  required,
  hasDefault: false,
});

const leaf = (path: string, type: string, writeOnly = false, required = false): SchemaLeaf => ({
  path,
  type,
  required,
  writeOnly,
  hasDefault: false,
});

/** One derivation, with the five empty arms spelled once. */
const derive = (subject: string, over: Partial<CatalogDerivation> = {}): CatalogDerivation => ({
  subject,
  description: NO_PROSE,
  arguments: [],
  argPaths: [],
  resultPaths: [],
  writeOnly: [],
  promptArguments: [],
  ...over,
});

/** A family's answer built from PAIRS, so `derived` cannot drift out of step with `items`:
 *  the shape's own rule is one entry each, in the same order. */
const family = (name: CatalogFamily, rows: [ListedItem, CatalogDerivation][]): CatalogResponse => ({
  family: name,
  items: rows.map(([item]) => item),
  derived: rows.map(([, each]) => each),
});

/* ------------------------------- the one cast -------------------------------- *
 * The three families every tunneled state lists, and the schemas every other pane
 * reads THROUGH them: the Recording table's paths are these tools' `argPaths`, the
 * Roles editor's ticks are these subjects, and every reach badge is these subjects
 * matched against the grants below. One cast, so no two panes can disagree about
 * what this app exposes.
 * ---------------------------------------------------------------------------- */

/** The one Markdown description of the preview — descriptions are Markdown by convention,
 *  so a gallery that showed none would not be showing what this pane looks like. */
const PAPER_FETCH_TEXT = "Fetch the paper identified by a **DOI** and return its text as Markdown.";

const PAPER_FETCH_PROSE: RenderedProse = {
  inline: "Fetch the paper identified by a <strong>DOI</strong> and return its text as Markdown.",
  block: "<p>Fetch the paper identified by a <strong>DOI</strong> and return its text as Markdown.</p>\n",
  text: "Fetch the paper identified by a DOI and return its text as Markdown.",
};

const paperFetch: [ListedItem, CatalogDerivation] = [
  {
    name: "paper_fetch",
    description: PAPER_FETCH_TEXT,
    inputSchema: { type: "object", required: ["doi"], properties: { doi: { type: "string" } } },
  },
  derive("paper_fetch", {
    description: PAPER_FETCH_PROSE,
    arguments: [arg("doi", "string", true)],
    argPaths: [leaf("doi", "string", false, true)],
  }),
];

const jobfeedCrawl: [ListedItem, CatalogDerivation] = [
  {
    name: "jobfeed_crawl",
    description: "Trigger a crawl of the configured job boards.",
    inputSchema: {
      type: "object",
      properties: {
        credentials: { type: "object", properties: { token: { type: "string", writeOnly: true } } },
        payload: { type: "object", properties: { key: { type: "string" } } },
      },
    },
  },
  derive("jobfeed_crawl", {
    description: plain("Trigger a crawl of the configured job boards."),
    arguments: [arg("credentials", "object", false), arg("payload", "object", false)],
    argPaths: [leaf("credentials.token", "string", true), leaf("payload.key", "string")],
    writeOnly: ["credentials.token"],
  }),
];

/**
 * Two paragraphs, which is what lets the listing row and the details card both be exact: the
 * row draws the FIRST paragraph (`inlineMarkdown`) and the card draws the whole of it, so one
 * description serves the short line and the long explanation the SSR fixtures typed apart.
 */
const SECRET_PUSH_TEXT =
  "Push a secret to the configured store.\n\n" +
  "`credentials.token` is never recorded — it is declared `writeOnly` and masked before the call reaches the trail.";

const SECRET_PUSH_PROSE: RenderedProse = {
  inline: "Push a secret to the configured store.",
  block:
    "<p>Push a secret to the configured store.</p>\n" +
    "<p><code>credentials.token</code> is never recorded — it is declared <code>writeOnly</code> and masked before the call reaches the trail.</p>\n",
  text:
    "Push a secret to the configured store. credentials.token is never recorded — it is declared writeOnly and masked before the call reaches the trail.",
};

const secretPush: [ListedItem, CatalogDerivation] = [
  {
    name: "secret_push",
    description: SECRET_PUSH_TEXT,
    inputSchema: {
      type: "object",
      properties: {
        credentials: {
          type: "object",
          properties: { user: { type: "string" }, token: { type: "string", writeOnly: true } },
        },
        payload: { type: "object", properties: { key: { type: "string" } } },
      },
    },
    outputSchema: {
      type: "object",
      properties: { out: { type: "object", properties: { stored: { type: "boolean" } } } },
    },
  },
  derive("secret_push", {
    description: SECRET_PUSH_PROSE,
    arguments: [arg("credentials", "object", false), arg("payload", "object", false)],
    argPaths: [
      leaf("credentials.user", "string"),
      leaf("credentials.token", "string", true),
      leaf("payload.key", "string"),
    ],
    resultPaths: [leaf("out.stored", "boolean")],
    writeOnly: ["credentials.token"],
  }),
];

const digestDaily: [ListedItem, CatalogDerivation] = [
  {
    name: "digest_daily",
    description: "Summarise the last 24 h.",
    arguments: [
      { name: "hours", description: "How far back to read.", required: false },
      { name: "audience", description: "", required: true },
    ],
  },
  derive("digest_daily", {
    description: plain("Summarise the last 24 h."),
    // A prompt declares ARGUMENTS, not a schema (§20.3): `promptArguments` is the app's own
    // declaration, and `arguments`/`argPaths` stay empty because there is no schema to walk.
    promptArguments: [
      { name: "hours", description: plain("How far back to read."), required: false },
      { name: "audience", description: NO_PROSE, required: true },
    ],
  }),
];

const feedResource: [ListedItem, CatalogDerivation] = [
  { uri: "news://feed/hn", mimeType: "text/plain" },
  derive("news://feed/hn"),
];

const configResource: [ListedItem, CatalogDerivation] = [
  { uri: "news://config", mimeType: "application/json" },
  derive("news://config"),
];

/** What `mcp-tools` advertises, per family. `resourceTemplates` is a LISTED empty family and
 *  not an absent one: the app declares `resources`, so the page asks for both halves of that
 *  one keyspace and a missing answer would read as unread. */
const CATALOG: Record<CatalogFamily, CatalogResponse> = {
  tools: family("tools", [paperFetch, jobfeedCrawl, secretPush]),
  prompts: family("prompts", [digestDaily]),
  resources: family("resources", [feedResource, configResource]),
  resourceTemplates: family("resourceTemplates", []),
};

/** A family that could not be read — §3's third answer, and the reason `Seed.queries` has an
 *  error channel at all: `unread` is what tells the client this is not an empty listing. */
const UNREAD = {
  status: 503,
  body: { reason: "Token refresh failed — calls return errors until you reconnect.", unread: true },
};

/* ------------------------------- the app rows -------------------------------- */

/** §23.6's committed names for this app: the service's and one per listed tool, which is
 *  what makes a member's TypeScript path exist — a path missing either half is not a name
 *  any generated program could have been written against. */
const TUNNEL_RESERVATIONS: AliasReservation[] = [
  { appId: "app_7Qk2Mv", family: "service", canonicalName: "mcp-tools", typescriptName: "mcpTools", source: "generated", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "jobfeed_crawl", typescriptName: "jobfeedCrawl", source: "generated", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "paper_fetch", typescriptName: "paperFetch", source: "generated", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "secret_push", typescriptName: "secretPush", source: "generated", active: true },
];

/** The app's own declaration (§20.3). `publisher` also names a role the owner had defined,
 *  which is what makes its badge read `app · replaced yours`. */
const DECLARED: RoleDeclaration = {
  reader: { tools: ["paper_fetch", "search_.*"], prompts: ["digest_.*"] },
  publisher: { tools: ["publish", "delete_feed"] },
};

/** The owner's own map. `publisher` is here too and is invisible on the page: the app's
 *  declaration replaced it, and `effective` is what every surface resolves against. */
const OWNER: RoleDeclaration = {
  publisher: { tools: ["publish"] },
  triage: { tools: ["jobfeed_crawl"] },
};

/** The same role carrying a PATTERN and a second family — what the editor states exist to
 *  show (a locked tick under a pattern, and the pattern row with its remove control), and
 *  what a role holding one literal cannot show at all. */
const TRIAGE_PATTERNED = { tools: ["jobfeed_crawl", "secret_.*"], resources: ["news://feed/hn"] };

const TUNNEL: AppRow = {
  slug: "mcp-tools",
  name: "mcp-tools",
  description: "The house tools — papers, job feeds and the odd secret push.",
  archived: false,
  logBodies: true,
  roles: DECLARED,
  // Two maps, not one: an argument mask and a result mask are different decisions made in
  // different rows of the Recording pane, and its summary counts both.
  redact: { secret_push: ["payload.key"] },
  redactResults: { secret_push: ["out.stored"] },
  typescriptAliases: {},
  typescriptReservations: TUNNEL_RESERVATIONS,
  typescriptDiagnostics: [],
  createdAt: ms("2026-08-12T09:00:00.000Z"),
  kind: "tunnel",
  status: "online",
  lastSeen: NOW,
  ownerRoles: OWNER,
};

/** The OAuth proxied half: connected, so the header draws Reconnect beside Disconnect. */
const LINEAR: AppRow = {
  ...TUNNEL,
  slug: "linear",
  name: "Linear",
  description: "Issues and cycles over the Linear MCP.",
  roles: {},
  redact: {},
  redactResults: {},
  typescriptReservations: [],
  kind: "proxy",
  status: undefined,
  lastSeen: undefined,
  ownerRoles: undefined,
  endpoint: "https://mcp.linear.app/mcp",
  auth: "oauth",
  forwardIdentity: true,
  capabilities: ["tools", "prompts", "resources", "completions"],
  connection: "connected",
};

/** The other proxied half: headers-mode, so there is no OAuth dance to be connected by, no
 *  status word the header could say, and no Connect control. */
const NOTION: AppRow = {
  ...LINEAR,
  slug: "notion",
  name: "Notion",
  description: "Pages and databases over the Notion MCP.",
  endpoint: "https://mcp.notion.com/mcp",
  auth: "headers",
  connection: undefined,
};

/** Provisioned and never connected — `lastSeen: null` is the state that makes an app
 *  catalogless, and a different fact from offline. */
const WEATHER: AppRow = { ...TUNNEL, slug: "weather", name: "Weather bot", status: "offline", lastSeen: null };

const ARCHIVED: AppRow = { ...TUNNEL, archived: true };

/* --------------------------- the long-data app ------------------------------ */

/** 40 characters of slug: the width the framed rail ellipsizes at, and the widest name a
 *  listing row's first column can be handed. */
const LONG_SLUG = "incident-response-and-postmortem-runners";

/** The same 40 characters as a tool name — one token, so it cannot wrap at a hyphen. */
const LONG_TOOL = "search_incident_timeline_across_services";

/** 300 characters with no space in them: the declared pattern of an app whose tools share
 *  one flat namespace, and the longest unbreakable token a listing row can carry. */
const LONG_PATTERN =
  "incident_(?:timeline|summary|postmortem|rollup|digest|handover|escalation|acknowledge|" +
  "silence|reopen|annotate|link_change|link_deploy|link_alert|assign_commander|" +
  "assign_scribe|page_oncall|page_backup|declare|downgrade|upgrade|resolve|verify|" +
  "publish_status|retract_status|snapshot_states)_(?:v1|v2|v3)";

/** A 40-word description: what an app that documents itself in prose actually publishes,
 *  against the boards' five-word summaries. */
const LONG_DESCRIPTION =
  "Search the incident timeline across every connected service and return the matching " +
  "events in order, with the deploy, alert and chat messages that surround each one, so " +
  "an on-call responder can reconstruct what happened without opening four consoles " +
  "by hand.";

/** A 60-character path, taken by four tools and masked on two of them — so its row is MIXED
 *  and draws all four sub-rows whether or not `?which=` names it. */
const LONG_PATH = "incident.timeline.window.starting_at_iso_8601_timestamp";

const LONG: AppRow = {
  ...TUNNEL,
  slug: LONG_SLUG,
  name: "Incident response and postmortem runners (staging)",
  description: LONG_DESCRIPTION,
};

const longTool: [ListedItem, CatalogDerivation] = [
  {
    name: LONG_TOOL,
    description: LONG_DESCRIPTION,
    inputSchema: { type: "object", properties: { incident: { type: "object" } } },
  },
  derive(LONG_TOOL, { description: plain(LONG_DESCRIPTION), argPaths: [leaf(LONG_PATH, "string")] }),
];

/** The long app's own families — the one source its Catalog, its summary, its tiles and its
 *  rail marker are all counted from. */
const LONG_CATALOG: Record<CatalogFamily, CatalogResponse> = {
  ...CATALOG,
  tools: family("tools", [longTool, paperFetch, jobfeedCrawl, secretPush]),
};

/** One path, four tools, no output schema anywhere: the Recording pane's mixed row at its
 *  widest. Each tool is redeclared here because the PATH is the dataset. */
const LONG_RECORDING: Record<CatalogFamily, CatalogResponse> = {
  ...CATALOG,
  tools: family(
    "tools",
    [LONG_TOOL, "paper_fetch", "jobfeed_crawl", "secret_push"].map(
      (name): [ListedItem, CatalogDerivation] => [
        { name, description: "", inputSchema: { type: "object", properties: { incident: { type: "object" } } } },
        derive(name, { argPaths: [leaf(LONG_PATH, "string")] }),
      ],
    ),
  ),
};

/* ----------------------------- the capabilities ------------------------------ */

/** A tunneled app that HAS connected: tools, prompts and resources, no completions. */
const TUNNEL_CAPS: CapabilitiesResponse = { capabilities: ["tools", "prompts", "resources"], neverConnected: false };

/** Never connected: the default shape, and the flag that stops all four catalog reads. */
const NEVER: CapabilitiesResponse = { capabilities: ["tools"], neverConnected: true };

/** A proxied app's configured set — four families, because a proxy is asked live. */
const PROXY_CAPS: CapabilitiesResponse = {
  capabilities: ["tools", "prompts", "resources", "completions"],
  neverConnected: false,
};

/* -------------------------------- the roles ---------------------------------- */

/** The app's two declared roles plus the owner's one — §1's merge, in the order the listing
 *  walks it. `all` is never stored: the pane appends it. */
const ROLES: RolesResponse = {
  ownerRoles: OWNER,
  declaredRoles: DECLARED,
  effective: { reader: DECLARED.reader, publisher: DECLARED.publisher, triage: OWNER.triage },
};

/** The same three with `triage` carrying a pattern — the dataset the three editor states are
 *  seeded with, because a role holding one literal has no pattern row to draw. */
const ROLES_PATTERNED: RolesResponse = {
  ownerRoles: { ...OWNER, triage: TRIAGE_PATTERNED },
  declaredRoles: DECLARED,
  effective: { reader: DECLARED.reader, publisher: DECLARED.publisher, triage: TRIAGE_PATTERNED },
};

/** `publisher` declared as a PATTERN, so the shadowed editor has the read-only pattern row
 *  that is the whole point of it: a row the owner can see and cannot remove. */
const SHADOWED_PUBLISHER = { tools: ["publish_.*"] };
const ROLES_SHADOWED: RolesResponse = {
  ownerRoles: OWNER,
  declaredRoles: { ...DECLARED, publisher: SHADOWED_PUBLISHER },
  effective: { reader: DECLARED.reader, publisher: SHADOWED_PUBLISHER, triage: OWNER.triage },
};

/** A proxied app declares none, so every role is the owner's. */
const PROXY_ROLES: RolesResponse = {
  ownerRoles: { triage: OWNER.triage },
  declaredRoles: {},
  effective: { triage: OWNER.triage },
};

/** The same, with the pattern the unread editor can still edit when no item can be ticked. */
const PROXY_ROLES_PATTERNED: RolesResponse = {
  ownerRoles: { triage: TRIAGE_PATTERNED },
  declaredRoles: {},
  effective: { triage: TRIAGE_PATTERNED },
};

/** The long app's map: the shared three plus a 33-character role whose one pattern is 300
 *  characters, listed FIRST because that is where the long row belongs. The shared three are
 *  the PLAIN ones, as the SSR fixture's own `[longRoleRow, ...appRoles]` splice has them:
 *  the patterned `triage` belongs to the role-editor states, and carrying it here would put
 *  two more subjects in this listing's `triage` row than the baseline draws. */
const LONG_ROLE = "incident-responder-oncall-primary";
const LONG_ROLES: RolesResponse = {
  ownerRoles: { ...OWNER, [LONG_ROLE]: { tools: [LONG_PATTERN] } },
  declaredRoles: DECLARED,
  effective: {
    [LONG_ROLE]: { tools: [LONG_PATTERN] },
    reader: DECLARED.reader,
    publisher: DECLARED.publisher,
    triage: OWNER.triage,
  },
};

/* -------------------------------- the agents --------------------------------- */

/** What `claude` holds on `mcp-tools`, in §8's wire spelling: a role, two inline items — one
 *  of them approval-mode — and a resource PATTERN, which is what makes its resource reach
 *  1 of 2 rather than 0. */
const CLAUDE_ON_TOOLS = ["reader", "tool/paper_fetch", "tool/jobfeed_crawl:approval", "resource/news://feed/*"];

const claude: ListedAgent = {
  slug: "claude",
  name: "Claude",
  description: "the main agent",
  grants: { "mcp-tools": CLAUDE_ON_TOOLS, linear: ["triage"], notion: ["triage"] },
  createdAt: ms("2026-07-02T10:30:00.000Z"),
};

const pi: ListedAgent = {
  slug: "pi",
  name: "Raspberry Pi",
  description: "the home Raspberry Pi",
  grants: { "mcp-tools": ["triage:approval"], linear: ["triage"], notion: ["triage"] },
  createdAt: ms("2026-07-18T08:15:00.000Z"),
};

const AGENTS: ListedAgent[] = [claude, pi];

/** The long app's three holders, the first of them a 25-character slug with a 40-word
 *  description and a 300-character pattern among its entries. */
const LONG_AGENTS: ListedAgent[] = [
  {
    slug: "incident-responder-oncall",
    name: "Incident responder (on-call)",
    description: LONG_DESCRIPTION,
    // `tools/` — §8's PATTERN spelling, which is what the baseline's `allowed` row prints.
    // `tool/` would be a literal member whose name happens to be a 300-character regex.
    grants: { [LONG_SLUG]: [`tools/${LONG_PATTERN}`, `tool/${LONG_TOOL}:approval`] },
    createdAt: ms("2026-08-01T12:00:00.000Z"),
  },
  { ...claude, grants: { ...claude.grants, [LONG_SLUG]: CLAUDE_ON_TOOLS } },
  { ...pi, grants: { ...pi.grants, [LONG_SLUG]: ["triage:approval"] } },
];

/* -------------------------------- the tokens --------------------------------- */

/** The live key, used within the minute — which is what makes it the one the online socket
 *  presented, since which key opened a socket is derived and never stored. */
const LIVE_TOKEN: TokenInfo = {
  id: "tok_9f3k",
  kind: "app",
  refId: "app_7Qk2Mv",
  refSlug: "mcp-tools",
  prefix: "pmcp_app_9f3k",
  createdAt: ms("2026-08-12T09:00:00.000Z"),
  expiresAt: null,
  lastUsedAt: NOW,
  revokedAt: null,
};

/** The key the Issue POST just minted: never used, and newest, so it sorts above the live
 *  one. Its plaintext is `transient` and never a query answer (§4/§15). */
const NEW_TOKEN: TokenInfo = {
  ...LIVE_TOKEN,
  id: "tok_2b8x",
  prefix: "pmcp_app_2b8x",
  createdAt: NOW,
  lastUsedAt: null,
};

/** Provisioned with the app and never presented: `weather` HAS a key and has still never
 *  connected, which is why its two markers say different things. */
const WEATHER_TOKEN: TokenInfo = {
  ...LIVE_TOKEN,
  id: "tok_4w1t",
  refId: "app_4W1tHr",
  refSlug: "weather",
  prefix: "pmcp_app_4w1t",
  lastUsedAt: null,
};

const TOKENS: TokenInfo[] = [LIVE_TOKEN];

/* ------------------------------- the ledger ---------------------------------- */

/** How far back the Agents pane's per-row call count looks — `CALL_WINDOW_DAYS`, spelled as
 *  the milliseconds its filters carry. */
const CALL_WINDOW = 7 * 86_400_000;

/**
 * The `tools/call` window the Agents pane reads, as `audit_query` resolved it.
 *
 * One row per call, because the pane COUNTS rows by principal: a call count is not a field
 * anything answers with, so a seed that wants 144 has to carry 144.
 */
const ledger = (slug: string, calls: Record<string, number>): AuditResponse => {
  const rows: AuditRow[] = [];
  for (const [agent, count] of Object.entries(calls)) {
    for (let each = 0; each < count; each += 1) {
      rows.push({
        id: rows.length + 1,
        ts: NOW - (each + 1) * 60_000,
        ownerId: "usr_ahrzb",
        principal: `agent:${agent}`,
        event: "tools/call",
        app: slug,
        tool: "paper_fetch",
        outcome: "ok",
        durationMs: 42,
      });
    }
  }
  return {
    filters: {
      since: NOW - CALL_WINDOW,
      until: NOW,
      range: "custom",
      app: slug,
      event: "tools/call",
      limit: 500,
      offset: 0,
    },
    page: { rows, total: rows.length },
  };
};

/** The filters the pane spells, which are also its query key — every value a string, because
 *  that is how they go onto the URL. */
const callFilters = (slug: string): Record<string, string> => ({
  app: slug,
  event: "tools/call",
  since: String(NOW - CALL_WINDOW),
  until: String(NOW),
});

/* -------------------------------- the cache ---------------------------------- */

/**
 * One state's query cache, assembled the way the page asks for it.
 *
 * The family loop is the point: it applies `asks()`'s own rule — nothing is requested for a
 * never-connected app, and nothing for a family the app does not advertise — so a state
 * cannot seed an answer the page would never have asked for, which is exactly how a `—`
 * marker would come to read as a `0`.
 */
function cache(state: {
  app: AppRow;
  caps: CapabilitiesResponse;
  /** What the four families answer, where it is not the shared cast. */
  catalog?: Record<CatalogFamily, CatalogResponse>;
  /** Every declared family answers 503 `unread` — one app, nothing known about its catalog. */
  unread?: boolean;
  roles?: RolesResponse;
  agents?: ListedAgent[];
  tokens?: TokenInfo[];
  /** §23.6's sentences, already rendered by the server and index-aligned with the row's own
   *  `typescriptDiagnostics`. */
  diagnostics?: AliasDiagnostic[];
  /** Agent slug → calls in the window. Present only for the states that draw the Agents
   *  pane, which is the one reader of the ledger on this page. */
  calls?: Record<string, number>;
}): Seed["queries"] {
  const slug = state.app.slug;
  const catalog = state.catalog ?? CATALOG;
  const queries: Seed["queries"] = [
    {
      key: keys.app(slug),
      data: {
        app: state.app,
        kind: state.app.kind === "proxy" ? "proxy" : "tunnel",
        diagnostics: state.diagnostics ?? [],
      } satisfies AppResponse,
    },
    { key: keys.appCapabilities(slug), data: state.caps },
  ];
  for (const name of ["tools", "prompts", "resources", "resourceTemplates"] as const) {
    if (state.caps.neverConnected) continue;
    if (!state.caps.capabilities.includes(CAPABILITY_OF_FAMILY[name])) continue;
    const key = keys.appCatalogFamily(slug, name);
    queries.push(state.unread === true ? { key, error: UNREAD } : { key, data: catalog[name] });
  }
  queries.push({ key: keys.appRoles(slug), data: state.roles ?? ROLES });
  queries.push({ key: keys.agents(), data: { agents: state.agents ?? AGENTS } });
  queries.push({ key: keys.tokens(), data: { tokens: state.tokens ?? TOKENS } });
  if (state.calls !== undefined) {
    queries.push({ key: keys.audit(callFilters(slug)), data: ledger(slug, state.calls) });
  }
  return queries;
}

/** The pane URL one state renders at — which route is open IS part of the state: the rail's
 *  `aria-current`, the narrow level and the pane switch are all functions of it. */
const pane = (slug: string, name: string): string => `/apps/${slug}/${name}`;

/* --------------------------- the shared query sets --------------------------- */

/** The tunneled app, everything readable — what most states differ from by their URL alone. */
const TUNNEL_CACHE = cache({ app: TUNNEL, caps: TUNNEL_CAPS });

/** The same, plus the ledger the Agents pane reads: 144 calls by claude in the window, none
 *  by pi. */
const ACCESS_CACHE = cache({ app: TUNNEL, caps: TUNNEL_CAPS, calls: { claude: 144, pi: 0 } });

/** The role editor states' cache — the role that carries a pattern. */
const EDITING_CACHE = cache({ app: TUNNEL, caps: TUNNEL_CAPS, roles: ROLES_PATTERNED });

/** The OAuth proxied app, everything readable. */
const PROXY_CACHE = cache({ app: LINEAR, caps: PROXY_CAPS, roles: PROXY_ROLES, tokens: [] });

/* ------------------------- the Overview's alias surface ---------------------- */

/** §23.6's surface as a healthy app is in: a configured service name, two configured aliases
 *  over the members this app lists, and the committed map with one tombstone. */
const NEWS_ALIASES: TypescriptAliases = {
  service: "news",
  tools: { digest_latest: "latest", get_news: "", search_feeds: "searchFeeds" },
};

const NEWS_RESERVATIONS: AliasReservation[] = [
  { appId: "app_7Qk2Mv", family: "service", canonicalName: "news", typescriptName: "news", source: "owner", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "digest_latest", typescriptName: "latest", source: "owner", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "get_news", typescriptName: "getNews", source: "generated", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "search_feeds", typescriptName: "searchFeeds", source: "owner", active: true },
  { appId: "app_7Qk2Mv", family: "tool", canonicalName: "old_digest", typescriptName: "oldDigest", source: "generated", active: false },
];

const ALIAS_APP: AppRow = { ...TUNNEL, typescriptAliases: NEWS_ALIASES, typescriptReservations: NEWS_RESERVATIONS };

/** The editor's prefill is the configured entries UNION every tool the catalog lists, so the
 *  catalog of these states is the three members the alias map is about — otherwise the table
 *  would draw six rows about two different apps. */
const ALIAS_CATALOG: Record<CatalogFamily, CatalogResponse> = {
  ...CATALOG,
  tools: family(
    "tools",
    ["digest_latest", "get_news", "search_feeds"].map(
      (name): [ListedItem, CatalogDerivation] => [{ name, description: "" }, derive(name)],
    ),
  ),
};

const OVERVIEW_CACHE = cache({ app: ALIAS_APP, caps: TUNNEL_CAPS, catalog: ALIAS_CATALOG });

/* ------------------------------- the 47 states ------------------------------- */

/**
 * Every state of `/apps/<slug>`, keyed exactly as the server fixtures keyed them.
 *
 * The bulk is in the consts above, and each entry says only what makes it that state: its
 * URL, the one answer it changes, the dialog its search opens, the transient a submit would
 * have produced. A state that differs from another only in which pane is open reads that way
 * here, because that is all that differs.
 */
export const appDetailSeeds: Record<string, Seed> = {
  /** A tunneled app online at the LANDING URL, which draws exactly what the Catalog pane's
   *  own URL draws and differs from it only in the narrow level. */
  default: { path: "/apps/mcp-tools", queries: TUNNEL_CACHE },

  /** The same render at the pane's own URL, which is level 2 on the phone. */
  catalog: { path: pane("mcp-tools", "catalog"), queries: TUNNEL_CACHE },

  /** A tool selected: the Arguments card, the Result card, and the four lines only the hub
   *  knows — both identities, the reach, the approval and the masking. */
  catalogTool: {
    path: pane("mcp-tools", "catalog"),
    search: { sel: "tool:secret_push" },
    queries: TUNNEL_CACHE,
  },

  /** The prompt arm of that card, whose rows are a DECLARATION rather than a schema. */
  catalogPrompt: {
    path: pane("mcp-tools", "catalog"),
    search: { sel: "prompt:digest_daily" },
    queries: TUNNEL_CACHE,
  },

  /** And the resource arm: a URI, its type, the one endpoint that serves it, and no schema
   *  card at all — a URI is not a body. */
  catalogResource: {
    path: pane("mcp-tools", "catalog"),
    search: { sel: "resource:news://feed/hn" },
    queries: TUNNEL_CACHE,
  },

  /** The filter with nothing matching: `no match` under each heading, and the headings still
   *  counting their families — the pane says how many there are, the rows which matched. */
  catalogNoMatch: { path: pane("mcp-tools", "catalog"), search: { q: "zzz" }, queries: TUNNEL_CACHE },

  /** A headers-mode proxied app: the upstream card without the OAuth controls, and no status
   *  word, because there is no connection to be in a state. */
  catalogProxied: {
    path: pane("notion", "catalog"),
    queries: cache({
      app: NOTION,
      caps: PROXY_CAPS,
      // The baseline draws this proxied catalog with the TUNNELED app's reach on every row,
      // because its fixture reused `catalogPane()`'s default groups. A reach badge is
      // DERIVED from roles and grants, so reproducing it means seeding `notion` with the
      // same ones — which is also what makes this state about the header card (no OAuth
      // controls, no status word) rather than about a second grant shape.
      roles: ROLES,
      agents: [
        { ...claude, grants: { ...claude.grants, notion: CLAUDE_ON_TOOLS } },
        { ...pi, grants: { ...pi.grants, notion: ["triage:approval"] } },
      ],
      tokens: [],
    }),
  },

  /** Provisioned and never connected: no catalog at all, so the pane says so and the rail's
   *  Catalog marker DIMS — this app advertises nothing yet, which is not a failure. */
  catalogUnconnected: {
    path: pane("weather", "catalog"),
    queries: cache({ app: WEATHER, caps: NEVER, agents: [], tokens: [WEATHER_TOKEN] }),
  },

  /** The listing failed: the state SAID in place of an empty set, with the Reconnect that
   *  fixes it, and a BLANK marker — an unread count is not an empty set. */
  catalogUnread: {
    path: pane("linear", "catalog"),
    queries: cache({ app: LINEAR, caps: PROXY_CAPS, unread: true, roles: PROXY_ROLES, tokens: [] }),
  },

  /** Every source badge at once: declared by the app, declared over one of yours, yours, and
   *  the built-in nobody declares. */
  roles: { path: pane("mcp-tools", "roles"), queries: TUNNEL_CACHE },

  /** One of the owner's own roles open: ticks, a locked tick under a pattern, every family
   *  the app has, and the foot that can delete. */
  rolesEditing: { path: pane("mcp-tools", "roles"), search: { sel: "role:triage" }, queries: EDITING_CACHE },

  /** A role that does not exist yet: the name is an input, nothing is ticked, and the foot
   *  carries Discard and Save. */
  rolesNew: { path: pane("mcp-tools", "roles"), search: { new: "1" }, queries: TUNNEL_CACHE },

  /** A filter no item matches, offered as a PATTERN — the only way a role gains one. */
  rolesOffer: {
    path: pane("mcp-tools", "roles"),
    search: { sel: "role:triage", q: "admin_.*" },
    queries: EDITING_CACHE,
  },

  /** The proxied half: a proxied app declares no roles, so every role is the owner's. */
  rolesProxied: { path: pane("linear", "roles"), queries: PROXY_CACHE },

  /** A refused save, drawn against the draft that caused it rather than through a redirect. */
  rolesRefused: {
    path: pane("mcp-tools", "roles"),
    search: { sel: "role:triage" },
    queries: EDITING_CACHE,
    transient: { refusal: { reason: "triage is declared by the app — its declaration would replace yours" } },
  },

  /** The shadowed role: the app declares a name the owner had defined, so its declaration
   *  replaced theirs and the editor is read-only down to the pattern row. */
  rolesShadowed: {
    path: pane("mcp-tools", "roles"),
    search: { sel: "role:publisher" },
    queries: cache({ app: TUNNEL, caps: TUNNEL_CAPS, roles: ROLES_SHADOWED }),
  },

  /** The catalog could not be read: no rows to tick, so a save moves no literal — and the
   *  editor says so rather than drawing an empty role. */
  rolesUnread: {
    path: pane("linear", "roles"),
    search: { sel: "role:triage" },
    queries: cache({ app: LINEAR, caps: PROXY_CAPS, unread: true, roles: PROXY_ROLES_PATTERNED, tokens: [] }),
  },

  /** The by-path mask editor: one path locked by the app's own `writeOnly`, one MIXED across
   *  the two tools that take it, and the masked list beside them. */
  recording: { path: pane("mcp-tools", "recording"), queries: TUNNEL_CACHE },

  /** `?which=` open on a path every tool declares `writeOnly`: per-tool rows, all locked, no
   *  control that could clear them, and the link now reading `hide`. */
  recordingExpanded: {
    path: pane("mcp-tools", "recording"),
    search: { which: "args:credentials.token" },
    queries: TUNNEL_CACHE,
  },

  /** Body logging off: the switch is off, the rail's dot is off, and the masks below apply
   *  once it is turned back on. */
  recordingOff: {
    path: pane("mcp-tools", "recording"),
    queries: cache({ app: { ...TUNNEL, logBodies: false }, caps: TUNNEL_CAPS }),
  },

  /** The proxied warning and its premise, which have to agree: nothing is masked and no
   *  schema is cached, so no path is marked `writeOnly` and no card lists one. */
  recordingProxiedWarning: {
    path: pane("linear", "recording"),
    queries: cache({
      app: LINEAR,
      caps: PROXY_CAPS,
      roles: PROXY_ROLES,
      tokens: [],
      catalog: {
        ...CATALOG,
        tools: family("tools", [
          [
            { name: "create_page", description: "" },
            derive("create_page", { argPaths: [leaf("credentials.token", "string"), leaf("query", "string")] }),
          ],
          [{ name: "search", description: "" }, derive("search", { argPaths: [leaf("query", "string")] })],
        ]),
      },
    }),
  },

  /** A refused save, redrawn with the reason above the rows and the draft intact. */
  recordingRefused: {
    path: pane("mcp-tools", "recording"),
    queries: TUNNEL_CACHE,
    transient: { refusal: { reason: '"redact" paths must be dotted JSON paths' } },
  },

  /** The facts, wide, and §23.6's alias surface below them: the editor, the committed map
   *  with its tombstone, and no diagnostic. */
  overview: { path: pane("mcp-tools", "overview"), queries: OVERVIEW_CACHE },

  /** The proxied Overview: three more facts, the header card above it without them, and
   *  nothing reserved — a proxied app is not addressed by a generated name here. */
  overviewProxied: { path: pane("linear", "overview"), queries: PROXY_CACHE },

  /** A refused alias save: the op's sentence above the editor, and the diagnostic that
   *  explains the omitted member beside the committed map. */
  overviewRefused: {
    path: pane("mcp-tools", "overview"),
    queries: cache({
      app: {
        ...ALIAS_APP,
        typescriptDiagnostics: [
          { family: "tool", canonicalName: "search_feeds", typescriptName: "searchFeeds", reason: "established" },
        ],
      },
      caps: TUNNEL_CAPS,
      catalog: ALIAS_CATALOG,
      diagnostics: [
        {
          family: "tool",
          canonicalName: "search_feeds",
          message:
            'tool "search_feeds": the derived TypeScript name ("searchFeeds") is already reserved; configure an explicit alias',
        },
      ],
    }),
    // The refusal SENTENCE only: `AppAliasView` carried one `error` and no per-field
    // violations, so a field-scoped line under the table is a row the baseline never drew.
    transient: {
      refusal: {
        reason: 'TypeScript name "latest2" is held by tool "digest_latest"; contenders: tool "digest_latest"',
      },
    },
  },

  /** Who holds a grant, what it holds spelled both ways, and how far that reaches today. */
  agents: { path: pane("mcp-tools", "access"), queries: ACCESS_CACHE },

  /** An agent selected: the agent page's grant editor, verbatim — every effective role, one
   *  group per family, and the Patterns group for the entries that are not one item. */
  agentsEditing: {
    path: pane("mcp-tools", "access"),
    search: { sel: "agent:claude" },
    queries: ACCESS_CACHE,
  },

  /** Nothing granted yet: the note still says where a grant starts, and the card still
   *  answers per tool — `no agent` is the answer it exists to give. */
  agentsEmpty: {
    path: pane("mcp-tools", "access"),
    queries: cache({ app: TUNNEL, caps: TUNNEL_CAPS, agents: [], calls: {} }),
  },

  /** A refused grant save, redrawn on the submitted choices. */
  agentsRefused: {
    path: pane("mcp-tools", "access"),
    search: { sel: "agent:claude" },
    queries: ACCESS_CACHE,
    transient: { refusal: { reason: 'role "editor" is not declared by mcp-tools' } },
  },

  /** The live key, Issue beside the title, Revoke behind its dialog — and the badge that says
   *  which key the open socket presented. */
  token: { path: pane("mcp-tools", "token"), queries: TUNNEL_CACHE },

  /** No key at all: the app cannot dial in until one is issued. */
  tokenEmpty: {
    path: pane("mcp-tools", "token"),
    queries: cache({ app: TUNNEL, caps: TUNNEL_CAPS, tokens: [] }),
  },

  /** The proxied half: a wide pane, §2's reason, and no control at all. */
  tokenProxied: { path: pane("linear", "token"), queries: PROXY_CACHE },

  /** The state only the Issue POST can produce: a plaintext, in the details of the key it
   *  just minted, in the one response that will ever carry it. */
  tokenRevealed: {
    path: pane("mcp-tools", "token"),
    search: { sel: "token:tok_2b8x" },
    queries: cache({ app: TUNNEL, caps: TUNNEL_CAPS, tokens: [NEW_TOKEN, LIVE_TOKEN] }),
    transient: { revealedToken: { token: "pmcp_app_2b8xQv7Ld0Rk4Ht1Zc6Ns9Wj3Fy", id: "tok_2b8x" } },
  },

  /** One selected with no mint behind it, so this is the ordinary details card. */
  tokenSelected: {
    path: pane("mcp-tools", "token"),
    search: { sel: "token:tok_9f3k" },
    queries: TUNNEL_CACHE,
  },

  /** Archive and Delete, each behind its own dialog, with the counts that say what each one
   *  costs. */
  danger: { path: pane("mcp-tools", "danger"), queries: TUNNEL_CACHE },

  /** The archived app: the banner on every pane, and Unarchive in Archive's place — the one
   *  control here that destroys nothing and needs no dialog. */
  dangerArchived: {
    path: pane("mcp-tools", "danger"),
    queries: cache({ app: ARCHIVED, caps: TUNNEL_CAPS }),
  },

  /** The archive confirmation, open on the pane that draws its control. */
  confirmArchive: {
    path: pane("mcp-tools", "danger"),
    search: { confirm: "archive" },
    queries: TUNNEL_CACHE,
  },

  /** The delete confirmation, which names what it revokes and closes. */
  confirmDelete: {
    path: pane("mcp-tools", "danger"),
    search: { confirm: "delete" },
    queries: TUNNEL_CACHE,
  },

  /** The remove-grant confirmation, drawn by the Agents pane because it submits that pane's
   *  own editor with the whole set cleared. */
  confirmRemoveAgent: {
    path: pane("mcp-tools", "access"),
    search: { confirm: "remove-agent", agent: "claude", sel: "agent:claude" },
    queries: ACCESS_CACHE,
  },

  /** The revoke confirmation on the key the live socket presented, which is why it says
   *  revoking closes the connection. */
  confirmRevokeToken: {
    path: pane("mcp-tools", "token"),
    search: { confirm: "revoke-token", id: "tok_9f3k" },
    queries: TUNNEL_CACHE,
  },

  /** Level 1 — the bare `/apps/<slug>`, the only URL that produces it: the header and the
   *  rail as a list, because the Catalog has a URL of its own to be level 2 at. */
  mobileLevel1: { path: "/apps/mcp-tools", queries: TUNNEL_CACHE },

  /** Level 2 — a pane's own URL, the listing filling the screen. */
  mobileLevel2: { path: pane("mcp-tools", "catalog"), queries: TUNNEL_CACHE },

  /** Level 3 — one row's details, with the way back to the listing that named it. */
  mobileLevel3: {
    path: pane("mcp-tools", "catalog"),
    search: { sel: "tool:secret_push" },
    queries: TUNNEL_CACHE,
  },

  /** The long-data Catalog: a 40-character slug in the title row and the rail, a 40-word
   *  description where the board draws one line, and a 40-character tool name. */
  longCatalog: {
    path: pane(LONG_SLUG, "catalog"),
    queries: cache({ app: LONG, caps: TUNNEL_CAPS, catalog: LONG_CATALOG, roles: LONG_ROLES, agents: LONG_AGENTS }),
  },

  /** The long-data Roles: a 33-character role name and a 300-character pattern, in the row
   *  and in the editor's pattern list. */
  longRoles: {
    path: pane(LONG_SLUG, "roles"),
    search: { sel: `role:${LONG_ROLE}` },
    queries: cache({ app: LONG, caps: TUNNEL_CAPS, catalog: LONG_CATALOG, roles: LONG_ROLES, agents: LONG_AGENTS }),
  },

  /** The long-data Recording: a 60-character path taken by four tools and masked on two, so
   *  the row is MIXED and draws all four sub-rows. */
  longRecording: {
    path: pane(LONG_SLUG, "recording"),
    queries: cache({
      app: { ...LONG, redact: { [LONG_TOOL]: [LONG_PATH], paper_fetch: [LONG_PATH] }, redactResults: {} },
      caps: TUNNEL_CAPS,
      catalog: LONG_RECORDING,
      roles: LONG_ROLES,
      agents: LONG_AGENTS,
    }),
  },

  /** The long-data Agents: three holders, the first with a 40-word description and a
   *  300-character pattern among its entries. */
  longAgents: {
    path: pane(LONG_SLUG, "access"),
    queries: cache({
      app: LONG,
      caps: TUNNEL_CAPS,
      catalog: LONG_CATALOG,
      roles: LONG_ROLES,
      agents: LONG_AGENTS,
      calls: { "incident-responder-oncall": 512, claude: 144, pi: 0 },
    }),
  },
};
