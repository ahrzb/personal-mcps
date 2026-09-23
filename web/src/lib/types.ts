/**
 * The wire shapes `/api/hub` answers with, spelled for the browser.
 *
 * DELIBERATELY A COPY, for `contracts/README.md`'s reason: the server's types live in
 * `server/src/admin.ts`, `registry.ts` and `api.ts`, and the client is not in the Worker's
 * dependency closure (§4's tech-stack rule, which is what keeps React out of it). So the
 * shapes are rewritten here rather than imported, and every field keeps the comment that
 * says what the server means by it — the copies are where the reasons would otherwise be
 * lost.
 *
 * Nothing here is validated at runtime. The producer is the hub's own `/api/hub`, reached
 * over a same-origin cookie-authenticated fetch, so a mismatch is a deploy that shipped
 * half of a change — a bug to fix, not an input to defend against.
 */

/** One of §20.2's four catalog families, as the API spells them in a URL. */
export type CatalogFamily = "tools" | "prompts" | "resources" | "resourceTemplates";

/** The three families a GRANT matches under (§20.3): resources and templates are one
 *  keyspace, a template matched on its raw `uriTemplate`. */
export type RoleFamily = "tools" | "prompts" | "resources";

/** A capability an app advertises (§20.2). `resourceTemplates` is not one: templates ride
 *  the `resources` capability. */
export type AppCapability = "tools" | "prompts" | "resources" | "completions";

/** How an app is reached (§1). `builtin` never reaches the client: every route that could
 *  report it answers 404 instead, exactly as the pages did. */
export type AppKind = "tunnel" | "proxy";

/** A role's patterns, per family — the stored declaration shape (§20.3). A family list is
 *  a SET: the door matches it and never walks it in order. */
export type FamilyPatterns = Partial<Record<RoleFamily, string[]>>;

/** Role name → its patterns. */
export type RoleDeclaration = Record<string, FamilyPatterns>;

/** §23.6's owner alias configuration: what the OWNER asked for, which is not necessarily
 *  what was committed (`typescriptReservations` is that). */
export type TypescriptAliases = { service?: string; tools?: Record<string, string> };

/** One committed TypeScript name (§23.6). `active: false` rows are history — a name that
 *  was established and has since moved. */
export type AliasReservation = {
  appId: string;
  family: string;
  canonicalName: string;
  typescriptName: string;
  source: string;
  active: boolean;
};

/** One thing `app_update`/`app_create` refused, in the OP's own field name (§8). */
export type Violation = { field: string; reason: string };

/**
 * One app, as `app_list` and `app_get` report it (§8's pinned cross-front shape). The
 * per-kind fields are optional here rather than a discriminated union: `kind` is the
 * discriminant every consumer already branches on, and a union would force a narrow at
 * every table cell that only reads `slug`.
 *
 * `kind: "builtin"` is absent on purpose — the virtual `pmcp` row exists in `app_list`'s
 * answer, and `/api/hub/apps/:slug` answers 404 for it, so a client that filters the
 * listing never holds one. Filter on `kind !== "builtin"` where you consume the LIST.
 */
export type AppRow = {
  slug: string;
  name: string;
  description: string;
  archived: boolean;
  /** Whether request and result bodies are recorded (§5). */
  logBodies: boolean;
  /** The APP's own role declaration. On a proxied app these are already all the owner's
   *  (§1), which is why the Roles editor writes `roles` there and `owner_roles` here. */
  roles: RoleDeclaration;
  /** Tool → the dotted argument paths masked in the ledger (§5). */
  redact: Record<string, string[]>;
  /** The same, for result bodies. */
  redactResults: Record<string, string[]>;
  /** §23.6's owner CONFIGURATION — what was asked for, not what was committed. */
  typescriptAliases: TypescriptAliases;
  /** §23.6's committed names, tombstones included (`active: false`) — what the runtime and
   *  the SDK actually see. */
  typescriptReservations: AliasReservation[];
  /** Why a requested alias did not land, where one did not. */
  typescriptDiagnostics: unknown[];
  /** `builtin` carries no creation date; every real row does. Epoch ms. */
  createdAt: number;
  /** The row's variant. The client never sees `"builtin"` for a single app. */
  kind: AppKind | "builtin";
  /** Tunnel only: whether a serving socket is live right now. An unreachable DO reads
   *  `offline` — it is holding no socket. */
  status?: "online" | "offline";
  /** Tunnel only. Epoch ms of the last connection, or null for NEVER — a different state
   *  from offline, and the one that makes an app catalogless. */
  lastSeen?: number | null;
  /** Tunnel only: the OWNER's roles (§20.3). Always present on a tunnel row, `{}` when the
   *  owner defined none. Absent on a proxied row, whose `roles` is already this. */
  ownerRoles?: RoleDeclaration;
  /** Proxy only: the upstream URL. */
  endpoint?: string;
  /** Proxy only: how the upstream is authenticated. */
  auth?: string;
  /** Proxy only: whether the caller's identity is forwarded (§7). */
  forwardIdentity?: boolean;
  /** Proxy only, and OPTIONAL on purpose: an app that never configured the key carries no
   *  key, which is a different fact from declaring the `["tools"]` default. */
  capabilities?: AppCapability[];
  /** Proxy only: the upstream credential's state (§7). */
  connection?: string;
};

/**
 * One credential, as `token_list` reports it — `identity.ts`'s `TokenInfo` verbatim.
 * Display data only: no secret material beyond the ~12-character `prefix`.
 */
export type TokenInfo = {
  id: string;
  kind: "app" | "agent";
  /** The OPAQUE id of the app or agent the token is bound to — the binding itself. */
  refId: string;
  /** That row's slug, which is what a table shows. */
  refSlug: string;
  /** The key's first ~12 characters, the only part of it that is ever reported. */
  prefix: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms, or null for never expires. */
  expiresAt: number | null;
  /** Epoch ms, COARSE — advanced at most hourly, so it is a rotation signal and not a
   *  request log. Null means never used. */
  lastUsedAt: number | null;
  /** Epoch ms, or null while the key is live. */
  revokedAt: number | null;
};

/** One agent and its grants, as `agent_list` reports them. `grants` is app slug → §8's wire
 *  spelling of each entry (`"<role>"` allow, `"<role>:approval"` approval). */
export type ListedAgent = {
  slug: string;
  name: string;
  description: string;
  grants: Record<string, string[]>;
  /** Epoch ms. */
  createdAt: number;
};

/**
 * One OAuth connection as the Credentials pane shows it — `oauth.ts`'s `Connection`
 * verbatim. Never a token, a client secret or a JWT (§8): a connection is a BINDING, and a
 * binding holds no credential.
 */
export type ConnectionRow = {
  id: string;
  clientId: string;
  /** The provider's display name, `null` when the client registered without one. */
  clientName: string | null;
  /** The agent this binding grants the client. */
  agentSlug: string;
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms, or null for never used. */
  lastUsedAt: number | null;
  /** Epoch ms when set, which TOMBSTONES the row — the op speaks timestamps and the pane
   *  derives `active` | `revoked`. A revoked row is kept, because re-consent revives it. */
  revokedAt: number | null;
  /** The ORIGIN of the client's first registered redirect URI (§19.5's identity line), `""`
   *  when the provider holds no client row for this id. Never the whole URI. */
  redirectOrigin: string;
  /** §19.3's DCR marker: nobody was signed in to vouch for this client at registration. */
  selfRegistered: boolean;
};

/** An approval's state (§7). `expired` and `used` are read-time interpretations: a
 *  past-expiry row is reported `expired` whatever is stored. */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "used";

/**
 * One approval as the owner sees it — `approvals.ts`'s `ApprovalRow` verbatim.
 *
 * The THREE stamps are ISO-8601 strings, not the epoch milliseconds every other row in this
 * file carries: `approvals.ts` reports them that way, and converting here would be a second
 * clock. Parse with `Date.parse` at the point of formatting.
 */
export type ApprovalRow = {
  id: string;
  agentSlug: string;
  appSlug: string;
  tool: string;
  /** The call's arguments POST-REDACTION — the only form ever stored (§15). */
  args: Record<string, unknown>;
  status: ApprovalStatus;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601, or null while pending. */
  decidedAt: string | null;
  /** ISO-8601. */
  expiresAt: string;
};

/** One listed declaration, as the owner listing reports it — whichever of §20.2's four
 *  descriptors its family serves, whole. Every field beyond the key is the upstream's own,
 *  so this is deliberately open. */
export type ListedItem = {
  name?: string;
  title?: string;
  description?: string;
  uri?: string;
  uriTemplate?: string;
  mimeType?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  arguments?: { name?: string; description?: string; required?: boolean }[];
};

/**
 * One row of §13's Arguments table, derived server-side from a tool's inputSchema: the
 * columns it draws and nothing more. `default` carries the schema's own VALUE — `false`, not
 * `"false"` — and is absent when the schema declares none, which is what `hasDefault` is
 * for: a declared `default: undefined` and no default at all are the same row to a reader
 * and would not be to a `default !== undefined` test.
 */
export type ArgumentRow = {
  name: string;
  /** The declared `type`, or `""` when the schema names none (a union type is not a word). */
  type: string;
  required: boolean;
  hasDefault: boolean;
  default?: unknown;
};

/**
 * One dotted LEAF of a schema — what the Catalog details' cards and the Recording pane's
 * path rows both read: the path, its type, and the three facts a mask decision turns on.
 * `writeOnly` means the app declared it so: already masked by §7, and never tickable.
 */
export type SchemaLeaf = {
  path: string;
  type: string;
  required: boolean;
  writeOnly: boolean;
  hasDefault: boolean;
  default?: unknown;
};

/**
 * One description, rendered three ways by the hub's ONE audited Markdown renderer
 * (`server/src/pages/markdown.ts`).
 *
 * App prose is UNTRUSTED — it is whatever the app answered `tools/list` with — and that
 * module is the only place in the system allowed to turn it into markup: its whitelist
 * escapes raw HTML, drops `id`/`class`/`style`, refuses every scheme but http/https/mailto,
 * emits no images and demotes headings. So it is rendered on the WIRE: a client-side
 * renderer would be a second whitelist to keep right, and printing the source instead would
 * show the reader an app's asterisks.
 *
 * Three forms because the surfaces need three, and each has one correct use:
 *  - `inline` in a one-line row;
 *  - `block` in a details card;
 *  - `text` in a `title` or `aria-label`, which cannot carry markup at all.
 *
 * `inline` and `block` are the ONLY strings this client may pass to
 * `dangerouslySetInnerHTML`, and only inside the `.md` container `styles.css` styles. All
 * three are `""` for an empty description.
 */
export type RenderedProse = { inline: string; block: string; text: string };

/** Everything a pane computes from one declaration, derived server-side because
 *  `catalog-view`, `registry` and `pages/markdown` own those computations and the browser
 *  must not hold a second implementation of any of them. */
export type CatalogDerivation = {
  /** The string a grant matches this item by: its name, or a resource's raw URI (§20.3). */
  subject: string;
  /** The declaration's own prose, all three forms — a row uses `inline`, a details card
   *  `block`, an endpoint tooltip `text`. */
  description: RenderedProse;
  /** §13's Arguments table. No prose here: a schema property carries a type and a default,
   *  not a description — only a PROMPT's declared arguments carry one. */
  arguments: ArgumentRow[];
  argPaths: SchemaLeaf[];
  resultPaths: SchemaLeaf[];
  /** Result paths §7 masks regardless of configuration. */
  writeOnly: string[];
  /** A PROMPT's declared arguments, the one place a per-argument description exists: a
   *  prompt carries no JSON Schema at all (§20.3), so its card draws the app's own
   *  declaration. Empty for every other family. */
  promptArguments: { name: string; description: RenderedProse; required: boolean }[];
};

/**
 * One audit event as read back — `audit.ts`'s `AuditRow` verbatim: the entry plus its row id
 * and the hub-stamped timestamp.
 *
 * `args` and `result` are set only on `tools/call` rows of apps whose `log_bodies` is on AND
 * whose call was actually dispatched. A refusal row NEVER carries bodies — several refusals
 * predate any redaction map — so absence here means "not recorded", which is a different
 * statement from "empty" and is why a surface drawing these must say which (§15).
 *
 * Both arrive ALREADY masked: the gateway applies §7's per-direction redaction unions before
 * the write, so the stored form is the only form. The client never masks anything.
 */
export type AuditRow = {
  id: number;
  /** Epoch ms, stamped by the hub at write time. */
  ts: number;
  ownerId: string;
  /** Who acted: `user:<name>` | `agent:<slug>` | `app:<slug>` | `bootstrap` | `hub`. The
   *  last is the MACHINE principal — lazy approval expiry and every scheduled run. */
  principal: string;
  /** The event vocabulary is `audit.ts`'s; `tools/list` is deliberately absent from it. */
  event: string;
  app?: string;
  /** The unprefixed tool name, where one applies. */
  tool?: string;
  /** `ok` | `-32000` | `-32001` | `-32002` | `-32003` | `error`. */
  outcome: string;
  /** Hub-measured wall time, consumer request to response. Set on every `tools/call` row
   *  (a denial is just a fast one), absent for every other event. */
  durationMs?: number;
  /** The consumer's self-declared clientInfo plus an allowlisted session id (§7):
   *  untrusted display data, never parsed, never an authorization input. */
  client?: { name?: string; version?: string; sessionId?: string };
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
  /** A small JSON summary. Never token material and never a body. */
  detail?: Record<string, unknown>;
};

/**
 * A whole body the ledger declined to store, replaced by its size and kind (§15's cap).
 * `bytes` is what the ORIGINAL weighed, never what was stored, and no surface prints it:
 * `derive.stubLabel` spells it `‹blob image/png · 4.2 MB›` / `‹oversize · 20 KB›`.
 */
export type BodyStub = {
  /** `blob` — one unstructured content block; `oversize` — the whole body was over the cap. */
  stub: "blob" | "oversize";
  /** Blob stubs only, and absent where the block declared none. */
  contentType?: string;
  bytes: number;
};

/** A recorded body as a surface receives it: the masked JSON object, or one whole-body stub
 *  where the body itself was replaced. A COPY of `pages/model.ts`'s `RecordedBody`. */
export type RecordedBody = Record<string, unknown> | BodyStub;

/**
 * Why a call row carries no bodies — the server's own three-way answer (`pages/model.ts`'s
 * `noBodiesReason`), computed there and never re-derived here: `refused` is decided first,
 * because a refusal never had bodies whatever the app's setting, then `off` (the app's
 * `log_bodies` is off NOW) and `unrecorded` (recorded before logging was on, or the app is
 * gone). The three sentences that go with these names are `features/audit/derive.ts`'s
 * `NO_BODIES_SENTENCE`.
 */
export type NoBodiesReason = "off" | "refused" | "unrecorded";

/**
 * One row of the explorer's window read — `audit.ts`'s `AuditSlimRow` minus the namespace id,
 * plus `noBodies`: the whole row EXCEPT its two body columns, which the explorer must never
 * ask for (§2: it reads thousands of rows and a body is up to `AUDIT_BODY_CAP_BYTES` each, so
 * the projection happens in SQL and the Worker never parses one to throw it away).
 *
 * The two replacements are what a listing actually draws. A row "has bodies" exactly when
 * `argsHead !== undefined || hasResult`, which is the test the server applies before it sets
 * `noBodies` — so a client that recomputed it would be a second opinion about the same fact.
 */
export type AuditWindowRow = Omit<AuditRow, "ownerId" | "args" | "result"> & {
  /** The first `AUDIT_ARGS_HEAD_CHARS` characters of the STORED args JSON (already masked,
   *  possibly an oversize stub's own JSON), for the one-line preview. Absent when the row
   *  recorded no args. */
  argsHead?: string;
  /** Whether a result column exists, without shipping it. */
  hasResult: boolean;
  noBodies?: NoBodiesReason;
};

/**
 * One row as the RECORD drawer reads it — `pages/model.ts`'s `AuditEventRow`, the full row
 * with its bodies typed for what they can hold. The drawer's field table is drawn from the
 * slim row it already has; this arrives afterwards, for the body sections alone.
 */
export type AuditEventRow = Omit<AuditRow, "ownerId" | "args" | "result"> & {
  args?: RecordedBody;
  result?: RecordedBody;
  noBodies?: NoBodiesReason;
};

/* ------------------------------ the responses ----------------------------- */

export type AppsResponse = { apps: AppRow[] };

/**
 * One app, plus the two things the row alone cannot say.
 *
 * `kind` is the REGISTRY's addressing kind beside the row's own; they agree, and the route
 * reports both rather than making the client assume it.
 *
 * `diagnostics` is §23.6's rendered sentences, each with the SUBJECT it is about — so a
 * details card can show only the diagnostics belonging to the member it has selected,
 * without pairing two arrays by index. `app.typescriptDiagnostics` carries the same facts as
 * raw objects because it is `app_get`'s own shape; read `diagnostics` and never that field.
 */
export type AppResponse = { app: AppRow; kind: AppKind; diagnostics: AliasDiagnostic[] };

/**
 * One §23.6 diagnostic: why a member has no TypeScript name, or is not using the one it
 * asked for.
 *
 * `message` is ALREADY RENDERED by `hub-types.aliasDiagnosticMessage` — the one author of
 * that prose, which the Terraform provider's refresh reads too — so the client prints it and
 * never composes one.
 */
export type AliasDiagnostic = { family: string; canonicalName: string; message: string };

export type CapabilitiesResponse = {
  capabilities: AppCapability[];
  /** A tunneled app that has never connected has no catalog at all (§13) — not an empty
   *  one, and not an unread one. */
  neverConnected: boolean;
};

/**
 * `/api/hub/audit`'s answer: the filters the server RESOLVED (a preset is a window, so
 * `since`/`until` always come back concrete) and the page that matched them.
 *
 * `total` is the whole match count, not the page's length — which is what a pager and a
 * "Load N more" control need, and the reason the two are separate fields.
 */
export type AuditResponse = {
  filters: {
    since: number;
    until: number;
    range: string;
    principal?: string;
    app?: string;
    event?: string;
    tool?: string;
    session?: string;
    limit: number;
    offset: number;
  };
  page: { rows: AuditRow[]; total: number };
};

/**
 * `/api/hub/audit/window`'s answer: one page of SLIM rows, newest first, plus everything the
 * page would otherwise have to compute a second time.
 *
 * `since` and `until` are the window the SERVER resolved and echoes, so the client never
 * computes "now" twice — the whole retention window ending now, unless the request named
 * one. `total` is the match count and `ceiling` is `AUDIT_EXPLORER_ROWS`: the over-ceiling
 * notice is a template over those two numbers and carries no literal of the constant itself.
 */
export type AuditWindowResponse = {
  rows: AuditWindowRow[];
  total: number;
  since: number;
  until: number;
  /** §15's retention, in days — the subtitle's "kept for N days" and the strip's widest preset. */
  retentionDays: number;
  ceiling: number;
};

/** `/api/hub/audit/<id>`'s answer: the one full row. A 404 means the id is not in the
 *  caller's namespace — unknown and foreign are deliberately indistinguishable. */
export type AuditRecordResponse = { row: AuditEventRow };

export type CatalogResponse = {
  family: CatalogFamily;
  items: ListedItem[];
  /** Parallel to `items`, one entry each. */
  derived: CatalogDerivation[];
  /** Tools only: whether a committed TypeScript name MOVED across this listing, which is
   *  the discovery boundary that allocates them. The app row has to be re-read when it
   *  does, so the identities the Overview and the Catalog print are the committed ones. */
  namesChanged?: boolean;
};
export type RolesResponse = {
  /** The owner's own map — the one the editor writes. */
  ownerRoles: RoleDeclaration;
  /** The app's declaration — names the owner may not take, because the declaration would
   *  replace theirs on sight (§20.3). */
  declaredRoles: RoleDeclaration;
  /** §1's merge: the map the DOOR resolves against. Every matcher reads this. */
  effective: RoleDeclaration;
};
export type AgentsResponse = { agents: ListedAgent[] };

/** `agents` is the whole namespace beside the named one, because the agent page's rail and
 *  its grant step both need the set — not a second read of the same listing. */
export type AgentResponse = {
  agent: ListedAgent;
  agents: ListedAgent[];
  connections: ConnectionRow[];
};
export type TokensResponse = { tokens: TokenInfo[] };
export type ApprovalsResponse = { approvals: ApprovalRow[] };

/**
 * One row as `/approvals/<id>` reads it — `api.ts`'s `DetailApproval`. `decidedAt` is
 * nullable on the wire because null is honest for a pending row, but `rejected` and `used`
 * are exactly the two statuses a decision writes, and the writer stamps `decided_at` in the
 * same statement — so on those two it is always a string, and the "Decided" line has
 * nothing else to render. The server makes the narrowing true before it answers.
 */
export type DetailApproval =
  | (ApprovalRow & { status: Exclude<ApprovalStatus, "rejected" | "used"> })
  | (ApprovalRow & { status: "rejected" | "used"; decidedAt: string });

/** `GET /api/hub/approvals/:id` — `api.ts`'s `ApprovalDetailRead`. A foreign id and an
 *  unknown one are ONE 404 (`{ reason: "No such approval." }`), so a probe learns nothing
 *  about another namespace (§7). */
export type ApprovalDetailRead = { approval: DetailApproval };

/**
 * `POST /api/hub/approvals/push`'s body — `api.ts`'s `PushSubscribeBody`: the browser's own
 * `PushSubscription.toJSON()`, of which the server keeps exactly these three strings and
 * refuses (400) anything missing one. Answers 204 with no body.
 */
export type PushSubscribeBody = {
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
};

/* ------------------------------------------------------------------ /settings ---- */

/** Whether TOTP is on — all `/get-session` reports (`twoFactorEnabled`). The backup codes
 *  live encrypted in identity's own table and no endpoint counts them, so the enabled arm
 *  carries nothing else. */
export type TwoFactorSummary = { enabled: false } | { enabled: true };

/** One passkey (`pages/model.ts`'s `PasskeyRow`). ISO-8601 stamps. */
export type PasskeyRow = {
  id: string;
  /** What the authenticator reported, else the model its AAGUID names, else "Passkey". */
  name: string;
  addedAt: string;
  /** §5's column; null until the passkey's first sign-in. */
  lastUsedAt: string | null;
};

/** One signed-in session (`pages/model.ts`'s `SessionRow`). NEVER carries the session
 *  token (§15) — a revoke names the row by `id` and the server maps it. */
export type SessionRow = {
  id: string;
  /** "Chrome on Windows", or "pmcp CLI" for a device-flow session. Untrusted display data. */
  client: string;
  source: "web" | "cli";
  /** ISO-8601. The CURRENT row's is also the "Confirmed your identity N minutes ago" clock:
   *  the recent-auth gate judges freshness on this value. */
  createdAt: string;
  /** ISO-8601. */
  lastActiveAt: string;
  /** The session asking — badged "current", never revocable from its own row. */
  current: boolean;
};

/** One row of the Tokens pane (`pages/model.ts`'s `TokenRow`): `token_list` minus revoked
 *  rows, with `expired` judged at read time because it also picks the control's word
 *  (Revoke a live key, Remove an expired one). Epoch ms. */
export type SettingsTokenRow = {
  id: string;
  prefix: string;
  kind: "agent" | "app";
  /** The app or agent slug the key is bound to. */
  boundTo: string;
  createdAt: number;
  /** null: never expires. */
  expiresAt: number | null;
  /** null: never presented. */
  lastUsedAt: number | null;
  expired: boolean;
};

/** An in-flight TOTP enrolment, as `POST …/two-factor/enable` answers it — `enrollmentOf`'s
 *  output. A credential in flight: held in component state only, never cached, never a URL. */
export type TotpEnrollment = {
  /** better-auth's `otpauth://` URI, which the QR encodes. */
  totpUri: string;
  /** The QR as a self-contained `data:image/svg+xml` URI — the card fetches nothing. */
  qrDataUri: string;
  /** The base32 secret grouped in fours for manual entry: "JBSW Y3DP EHPK 3PXP". */
  secret: string;
  /** A refused code's sentence (better-auth's own), or null. */
  error: string | null;
};

/**
 * `GET /api/hub/settings` — the ONE read behind the rail and every pane (§13: a marker is
 * the length of the list its pane draws, never a second query). Everything the URL decides —
 * the pane, `?kind=`, `?confirm=`, the flash, `?field=` — is the client's.
 */
export type SettingsRead = {
  twoFactor: TwoFactorSummary;
  passkeys: PasskeyRow[];
  sessions: SessionRow[];
  tokens: SettingsTokenRow[];
  connections: ConnectionRow[];
  /** §23.3's committed pair, milliseconds. */
  execution: { defaultTimeoutMs: number; maxTimeoutMs: number };
  /** Configuration the panes print, so the page holds no second literal of any of them:
   *  the password length hint, and the Execution inputs' bounds (ms). */
  limits: { passwordMinLength: number; minTimeoutMs: number; maxTimeoutMs: number };
};

/**
 * A settings write's answer where today's form got a 303: `next` is byte for byte the
 * Location it named (the server's own `noticeUrl`), and `reload` is true exactly when the
 * answer replaced the session — and with it the CSRF token this document holds — so the
 * client must load `next` as a document rather than route to it.
 */
export type Redirected = { next: string; reload: boolean };

/** `…/two-factor/enable`'s reveal: the enrolment plus the ten backup codes, shown once. */
export type TotpEnabled = { enrollment: TotpEnrollment; backupCodes: string[] };

/** `…/two-factor/generate-backup-codes`' reveal: a fresh set of ten, shown once. */
export type BackupCodesRevealed = { backupCodes: string[] };

/** `POST …/settings/change-password`'s body — `api.ts`'s `ChangePasswordBody`. The server
 *  checks new ≠ confirm itself, BEFORE calling better-auth, which has no confirm field. */
export type ChangePasswordBody = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  /** The checkbox's state as a boolean — anything else is a 400 naming this field. */
  revokeOtherSessions: boolean;
};

/** `POST …/settings/execution/hub_settings_update`'s body — `api.ts`'s `ExecutionUpdateBody`:
 *  the owner's TEXT for both controls, so the op's own count check refuses a non-integer under
 *  the field it names rather than a second validator saying it in other words. */
export type ExecutionUpdateBody = { default_timeout_ms: string; max_timeout_ms: string };

/* -------------------------------------------------------------------- /device ---- */

/**
 * The confirm card's facts (`pages/model.ts`'s `DeviceRequest`). Every field but `userCode`
 * is attacker-influenced or a stated ceiling — the device-flow channel is unauthenticated
 * (§7) — so the page renders each one as TEXT, never markup or a link.
 */
export type DeviceRequest = {
  /** The code as the owner asked for it: "BDWJ-KTQP". */
  userCode: string;
  /** KNOWN CEILING: better-auth records no requesting IP, so this is "unknown" rather than a
   *  guess that would look like corroboration while corroborating nothing. */
  ip: string;
  /** The requesting client's `client_id`, or "unknown" when this owner is not the claimant. */
  client: string;
  /** ISO-8601 — the read's own instant, which is what "Just now" is relative to. */
  requestedAt: string;
  /** ISO-8601 — `requestedAt` plus the device-code lifetime: the window's bound. */
  expiresAt: string;
};

/** `GET /api/hub/device?user_code=` — `api.ts`'s `DeviceRead`: the five facts and nothing
 *  else (no scope, no status, no device code). A code that is not live is 404 `{ reason }`,
 *  whose sentence the enter-code card shows under the field. */
export type DeviceRead = { request: DeviceRequest };

/** `POST /api/hub/device/decide`'s body; the answer is a `Redirected` landing on
 *  `/device?decided=approved|denied`, or `/device?error=…` when the code could not be decided. */
export type DeviceDecideBody = { userCode: string; decision: "approve" | "deny" };

/** The four shapes `POST /api/hub/apps` answers with, discriminated by which keys are
 *  present — one route, because two of the three arms carry something the client cannot ask
 *  for twice: a plaintext key shown once (§15), and an authorize URL bound to a single-use
 *  state row. */
export type CreatedApp = {
  slug: string;
  /** The DISPLAY name, defaulted to the slug when the owner left Name blank — §13's
   *  connecting screen reads "Connecting to <name>…", and a slug is not always the name. */
  name: string;
  /** Tunneled creates only: the plaintext key, shown exactly once, or null if the mint was
   *  refused. */
  token?: string | null;
  /** An oauth-mode proxied create whose Connect began. */
  connect?: { authorizeUrl: string };
  /** An oauth-mode proxied create whose Connect was refused — the app still exists. */
  connectError?: string;
};

/** Every ops-backed write's answer. */
export type OpValue = { value: unknown };
