// app-detail.tsx — /apps/<slug>: §13's eight panes of one app behind the same rail
// /settings uses.
//
// Pure: (props) => JSX. Every URL comes from `paths`, every count from the very list its
// pane draws, and the render instant arrives as `now` — so a pane renders identically
// from a fixture and from a request (model.ts's two template rules).
//
// ONE component draws the header, both navigations and whichever pane the URL asked for,
// because §13 makes them one page: a rail marker is the LENGTH of the list its pane
// renders, so the rail is drawn from the same props the pane is and cannot disagree with
// it. `props.pane` says which pane; the header and the two navigations are identical on
// all eight, which is what makes the landing render (Tools) the same response shape as
// every other.
//
// The hub block under an expanded tool row is §13's "what only the hub knows", and none
// of it is computed here: model.ts hands over the aggregated name, the reachability the
// DOOR's own matcher answered (catalog-view over registry.buildToolFilter), the approval
// posture that verdict already decided, and the redaction paths §7's own functions
// produced. This file only puts them in the sentences §13 pins.
//
// Everything destructive is behind a server-rendered `<dialog open>` reached by a URL
// (§13's `?confirm=`), so the confirm step works with scripting off — and the Token pane's
// Issue is the one control whose answer cannot survive a redirect, which is why its target
// is a route of its own rather than the generic dispatch (§15: a plaintext key never rides
// a URL).

import type { FC } from "hono/jsx";
import { ConfirmShell, Layout, PaneRail, PanePills, TokenReveal, paneGroups } from "./layout";
import type { PaneEntry } from "./layout";
import { alertClass, formatLastSeen, formatStamp } from "./format";
import { APP_CONFIRM_PANE, DIMMED, paths } from "./model";
import type {
  AppConfirm,
  AppDetailHeader,
  AppDetailPane,
  AppDetailProps,
  AppFamilyView,
  AppGrantChip,
  AppPromptRow,
  AppResourceRow,
  AppToolRow,
} from "./model";
import { inlineMarkdown, renderMarkdown } from "./markdown";
import { raw } from "hono/html";
import type { ArgumentRow, Reach } from "../catalog-view";
import type { FamilyPatterns } from "../registry";

/**
 * The accessible names of this page's two pane navigations. They exist because §13 puts
 * the same eight destinations in both at every width, so nothing else tells the rail from
 * the pill row — not for a reader listing the page's landmarks, and not for the suite.
 */
const RAIL_NAV_LABEL = "App panes";
const PILL_NAV_LABEL = "App panes, compact";

/* ------------------------------------------------------------------ rail --- */

/** The eight entries both navigations draw, in §13's table order, each carrying the
 *  marker model.ts computed beside the very list that entry's pane renders. */
function paneEntries(props: AppDetailProps): PaneEntry[] {
  return props.rail.map((entry) => ({
    href: entry.href,
    label: entry.label,
    // §13 shortens exactly one Settings label for the pill row and names none here, so
    // the app page's pills carry the rail's own words.
    short: entry.label,
    // The em dash is the ONE marker that means "advertises none" (§13), so it is also the
    // one that draws its entry receded — read from model's own constant, never respelled.
    marker: entry.marker === "" ? null : { text: entry.marker, dim: entry.marker === DIMMED },
    current: entry.pane === props.pane,
    // §13's two headings, then the ungrouped Danger zone — a headless run rather than a
    // third heading, because §13 makes that entry neutral and a heading of its own would
    // be the emphasis it refuses, by another route. The shell groups on this field.
    group: entry.group,
  }));
}

/* ---------------------------------------------------------------- header --- */

/** A status word's palette: green for the two live states, amber for the two that are
 *  waiting on the owner, muted for the rest. */
const STATUS_CLASS: Record<string, string> = {
  online: "badge badge--success",
  connected: "badge badge--success",
  "needs reconnect": "badge badge--warning",
  archived: "badge badge--warning",
};

const HeaderBadges: FC<{ header: AppDetailHeader }> = ({ header }) => (
  <div class="badge-row">
    <span class="badge badge--mono">{header.slug}</span>
    <span class="badge badge--mono">{header.kind}</span>
    {header.status === null ? null : (
      <span class={STATUS_CLASS[header.status] ?? "badge badge--muted"}>{header.status}</span>
    )}
  </div>
);

/**
 * The proxied half of §13's header: what the hub dials, how it authenticates, and whether
 * it forwards the caller's identity — plus, for `auth: oauth` alone, the same
 * Connect/Reconnect and Disconnect targets /apps draws, taken from `paths` so this page
 * cannot invent a third spelling of either.
 *
 * `rows` is off on the Overview pane alone: §13 gives those three facts to the header AND
 * to Overview, so there they would be the pane's own first rows printed again with nothing
 * between them. The controls stay on all eight — they belong to the header, not to a pane.
 */
const UpstreamCard: FC<{ header: AppDetailHeader; csrfToken: string; rows: boolean }> = ({
  header,
  csrfToken,
  rows,
}) => {
  const controls = header.connect !== null || header.disconnect !== null;
  if (!rows && !controls) return null;
  return (
    <div class="card card--pad">
      {rows ? (
        <div class="kv">
          <div class="kv-row">
            <div class="kv-key">Endpoint</div>
            <div class="mono">{header.endpoint}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Auth</div>
            <div class="mono">{header.authMode}</div>
          </div>
          <div class="kv-row">
            <div class="kv-key">Forward identity</div>
            <div>{header.forwardIdentity ? "On" : "Off"}</div>
          </div>
        </div>
      ) : null}
      {controls ? (
        <div class="actions">
          {header.connect === null ? null : (
            <form method="post" action={header.connect.href}>
              <input type="hidden" name="csrf" value={csrfToken} />
              <button type="submit" class="btn btn--outline btn--sm">
                {header.connect.label}
              </button>
            </form>
          )}
          {header.disconnect === null ? null : (
            <form method="post" action={header.disconnect}>
              <input type="hidden" name="csrf" value={csrfToken} />
              <button type="submit" class="btn btn--ghost btn--sm">
                Disconnect
              </button>
            </form>
          )}
        </div>
      ) : null}
    </div>
  );
};

/* ----------------------------------------------------------- empty states --- */

/**
 * Why a family pane has nothing to list, per kind — §20.2's owner-declared `capabilities`
 * for a proxied app, §20.5's registration-time declaration for a tunneled one. §13 pins
 * both verbatim with the family's own name substituted, which is why the family is a
 * parameter here rather than three copies of each sentence.
 */
/** A tunneled app that has never connected (§13, 2026-09-03): no catalog to list, for any
 *  family — the sentence is the same on all three panes, and it is not "declared none". */
const Unconnected: FC = () => (
  <div class="empty empty--inline">
    <div class="empty-text">This app has never connected, so the hub has no catalog to list yet.</div>
    <div class="empty-text empty-text--aside">
      Start it with its token and the catalog appears after its first connect.
    </div>
  </div>
);

const Undeclared: FC<{ family: string; kind: AppDetailHeader["kind"] }> = ({ family, kind }) => (
  <div class="empty empty--inline">
    {kind === "tunnel" ? (
      <>
        <div class="empty-text">
          This app declared no {family} capability on its last connect, so the hub advertises none and serves an
          empty list.
        </div>
        <div class="empty-text empty-text--aside">
          Declare {family} with your MCP SDK and they appear here after the next reconnect — the client library
          passes the declaration through untouched.
        </div>
      </>
    ) : (
      <div class="empty-text">
        The <code class="code-inline">capabilities</code> configured for this app omit {family} (§20.2) — add it
        with <code class="code-inline">app_update</code> or the YAML.
      </div>
    )}
  </div>
);

/**
 * A listing that could not be read at all — §13's "rendering that state in place of the
 * list" rather than an empty one. BOTH arms below say something, because rendering nothing
 * is less than an empty list, not more: a card with no rows, no count and no sentence is
 * exactly what §13 reserves for an app that advertises none.
 *
 * Which sentence depends on what could have failed. §13's copy is about a credential, so
 * it is drawn where a credential refresh exists to have failed — `auth: oauth`, the one
 * mode carrying a Connect target — beside the control that fixes it. A headers-mode
 * upstream has no refresh and no control, so telling its owner to reconnect would be a
 * lie; that arm says the thing that IS true of every unread listing. §13 pins no copy for
 * it (the plan's constraint 37(a) leaves the wording to the page), only that the state is
 * rendered.
 */
const Unread: FC<{ header: AppDetailHeader; csrfToken: string }> = ({ header, csrfToken }) =>
  header.connect === null ? (
    <div class="empty empty--inline">
      <div class="empty-text">
        Couldn't reach <code class="code-inline">{header.endpoint}</code> — the live listing failed, so nothing is
        shown; calls return errors until it answers again.
      </div>
    </div>
  ) : (
    <div class="empty empty--inline">
      <div class="empty-text">Token refresh failed — calls return errors until you reconnect.</div>
      <form method="post" action={header.connect.href}>
        <input type="hidden" name="csrf" value={csrfToken} />
        <button type="submit" class="btn btn--outline btn--sm">
          {header.connect.label}
        </button>
      </form>
    </div>
  );

/** The two answers a family view carries that are NOT a list, in the one place both are
 *  drawn — so "advertises none" and "could not be read" can never render as each other. */
const FamilyEmpty: FC<{
  view: Exclude<AppFamilyView<unknown>, { state: "listed" }>;
  family: string;
  header: AppDetailHeader;
  csrfToken: string;
}> = ({ view, family, header, csrfToken }) =>
  view.state === "unconnected" ? (
    <Unconnected />
  ) : view.state === "undeclared" ? (
    <Undeclared family={family} kind={header.kind} />
  ) : (
    <Unread header={header} csrfToken={csrfToken} />
  );

/* ----------------------------------------------------------------- tools --- */

/** §13's `no args` / `N args`, singular where the artboard draws it singular. */
function argCount(rows: ArgumentRow[]): string {
  if (rows.length === 0) return "no args";
  return rows.length === 1 ? "1 arg" : `${rows.length} args`;
}

/** §13's Arguments table — the tool's own `inputSchema`, top-level properties only; a
 *  nested schema prints its outer type and is not recursed into (the pinned ceiling: the
 *  row is a glance, and `pmcp describe` prints the schema whole). */
const Arguments: FC<{ rows: ArgumentRow[] }> = ({ rows }) => (
  <table class="table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Type</th>
        <th>Required</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <tr>
          <td class="cell-mono">{row.name}</td>
          <td class="cell-mono cell-muted">{row.type}</td>
          <td class="cell-muted">
            {row.required ? (
              "required"
            ) : row.hasDefault ? (
              <>
                optional · defaults to <code class="code-inline">{JSON.stringify(row.default)}</code>
              </>
            ) : (
              "optional"
            )}
          </td>
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * §13 line 2: every agent whose granted roles on this subject match, and the roles that
 * matched — the door's own verdict, put into the sentence §13 spells. One function for all
 * three families, because §13 gives them one sentence and §20.3 one matcher.
 *
 * §13's short form ("Reachable by `<agent>`, `<agent>` · via `<role>`") states one role
 * set about every agent it names, which is TRUE only where they all matched the same way.
 * Where two agents reached the subject through different roles, unioning the roles would
 * assert a cross-product the door never answered — each agent reading as though it held
 * both — so those name their own roles instead.
 */
function reachLine(reach: Reach[]): string {
  if (reach.length === 0) return "Reachable by no agent yet";
  const rolesOf = (entry: Reach) => entry.roles.join(", ");
  const shared = rolesOf(reach[0]);
  if (reach.every((entry) => rolesOf(entry) === shared)) {
    return `Reachable by ${reach.map((entry) => entry.agent).join(", ")} · via ${shared}`;
  }
  return `Reachable by ${reach.map((entry) => `${entry.agent} · via ${rolesOf(entry)}`).join("; ")}`;
}

/** §13 line 3. Allow wins over approval per agent (§2) and the door already decided it,
 *  so an agent holding both reaches in allow mode and is named by neither half of this
 *  line; owners are never gated, which is why it is about agents alone. */
function approvalLine(tool: AppToolRow): string {
  return tool.approvalAgents.length === 0
    ? "No approval required"
    : `Approval required for ${tool.approvalAgents.join(", ")}`;
}

/** §13 line 4: what a call would mask, or the refusal a tool with no derivable redaction
 *  map earns instead — two different statements that never collapse into one. */
function redactionLine(tool: AppToolRow): string {
  if (tool.schemaUnsound) return "schema-unsound — approval-gated calls refuse, bodies are not recorded";
  return maskedLine(tool.redactedArgs, tool.redactedResults);
}

/** The same sentence a prompt earns, which has an arguments half alone — §20.4 keeps
 *  prompt results out of the question, and §20.3 leaves it no `writeOnly` half either. */
function maskedLine(args: string[], results: string[]): string {
  const parts: string[] = [];
  if (args.length > 0) parts.push(`arguments ${args.join(", ")}`);
  if (results.length > 0) parts.push(`results ${results.join(", ")}`);
  return parts.length === 0 ? "No redacted fields" : `Redacted ${parts.join(" · ")}`;
}

/**
 * One Tools row, expanded IN PLACE: a native <details>, so the full description, the
 * Arguments table and the hub block all arrive in this same response and open with no
 * second request and no script of any kind.
 */
const ToolRow: FC<{ tool: AppToolRow }> = ({ tool }) => (
  <details class="disclosure tool">
    <summary>
      <span class="tool-name mono">{tool.name}</span>
      {/* The description's own Markdown, twice: inline for the summary line, which is one
          line by construction, and whole under it (markdown.ts owns the whitelist). */}
      <span class="tool-summary md">{raw(inlineMarkdown(tool.summary))}</span>
      <span class="tool-args">{argCount(tool.args)}</span>
    </summary>
    <div class="detail tool-detail">
      <div class="tool-description md">{raw(renderMarkdown(tool.description))}</div>
      {tool.args.length === 0 ? null : (
        <>
          <div class="eyebrow">Arguments</div>
          <Arguments rows={tool.args} />
        </>
      )}
      {/* §13's four lines, in the order it pins them: the aggregated name, who reaches it,
          the approval posture, then what a call would mask. */}
      <div class="tool-hub">
        <div>
          Called by agents as <code class="code-inline">{tool.aggregated}</code>
        </div>
        <div>{reachLine(tool.reach)}</div>
        <div>{approvalLine(tool)}</div>
        <div>{redactionLine(tool)}</div>
      </div>
    </div>
  </details>
);

/** A listing's own size beside its card title, in the boards' lighter weight — drawn only
 *  where the pane carries no other count (the Resources tabs carry theirs), and absent
 *  where the listing could not be read at all, for the rail marker's reason. */
const TitleCount: FC<{ view: AppFamilyView<unknown> }> = ({ view }) =>
  view.state === "listed" ? <span class="card-count">{view.rows.length}</span> : null;

const ToolsPane: FC<AppDetailProps> = (props) => (
  <div class="card card--pad">
    <div class="card-head">
      <div>
        <h2 class="card-title">
          Tools <TitleCount view={props.tools} />
        </h2>
        {props.header.kind === "tunnel" ? (
          <p class="card-desc">Advertised by the app on its last connect.</p>
        ) : null}
      </div>
      {props.header.kind === "tunnel" ? <p class="note">Re-listed on every reconnect</p> : null}
    </div>
    {props.tools.state === "listed" ? (
      <div class="list">
        {props.tools.rows.map((tool) => (
          <ToolRow tool={tool} />
        ))}
      </div>
    ) : (
      <FamilyEmpty view={props.tools} family="tools" header={props.header} csrfToken={props.csrfToken} />
    )}
    <p class="note">
      Schemas come from the app's last <code class="code-inline">tools/list</code> — the hub stores them, it does
      not author them.
    </p>
  </div>
);

/* --------------------------------------------------- prompts · resources --- */

/**
 * One Prompts row: §13's "the same shape without a schema table". The declared arguments
 * are a plain list rather than the Tools table — a prompt has no `inputSchema`, so there
 * is no type column to fill and printing one would invent a fact (§20.3).
 */
const PromptRow: FC<{ prompt: AppPromptRow }> = ({ prompt }) => (
  <details class="disclosure tool">
    <summary>
      <span class="tool-name mono">{prompt.name}</span>
      <span class="tool-summary md">{raw(inlineMarkdown(prompt.description))}</span>
    </summary>
    <div class="detail tool-detail">
      {prompt.args.length === 0 ? null : (
        <>
          <div class="eyebrow">Arguments</div>
          <div class="kv">
            {prompt.args.map((argument) => (
              <div class="kv-row">
                <div class="kv-key mono">{argument.name}</div>
                <div>
                  <span class="md">{raw(inlineMarkdown(argument.description))}</span>{" "}
                  <span class="muted">{argument.required ? "required" : "optional"}</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {/* §13's hub block for this family: the aggregated name, who reaches it over the
          role's PROMPT patterns, the posture §18 decision 27 fixed, and what a
          `prompts/get` would mask. */}
      <div class="tool-hub">
        <div>
          Called by agents as <code class="code-inline">{prompt.aggregated}</code>
        </div>
        <div>{reachLine(prompt.reach)}</div>
        <div>Never approval-gated</div>
        <div>{maskedLine(prompt.redacted, [])}</div>
      </div>
    </div>
  </details>
);

const PromptsPane: FC<AppDetailProps> = (props) => (
  <div class="card card--pad">
    <div>
      <h2 class="card-title">
        Prompts <TitleCount view={props.prompts} />
      </h2>
      <p class="card-desc">
        Reusable message templates the app offers — Claude Code turns them into slash commands.
      </p>
    </div>
    {props.prompts.state === "listed" ? (
      <div class="list">
        {props.prompts.rows.map((prompt) => (
          <PromptRow prompt={prompt} />
        ))}
      </div>
    ) : (
      <FamilyEmpty view={props.prompts} family="prompts" header={props.header} csrfToken={props.csrfToken} />
    )}
  </div>
);

/** A tab's own count — blank where its listing could not be read, for the rail's reason:
 *  an unread count is not an empty set. */
function countOf(view: AppFamilyView<unknown>): string {
  return view.state === "listed" ? String(view.rows.length) : "";
}

/** §13's two Resources tabs, each carrying its own count. Links rather than script, so a
 *  tab is a URL like everything else on this page. */
const ResourceTabs: FC<AppDetailProps> = (props) => (
  <div class="segmented">
    <a
      href={paths.appPane(props.header.slug, "resources")}
      aria-current={props.tab === "resources" ? "page" : undefined}
    >
      Resources {countOf(props.resources)}
    </a>
    <a
      href={`${paths.appPane(props.header.slug, "resources")}?tab=templates`}
      aria-current={props.tab === "templates" ? "page" : undefined}
    >
      Templates {countOf(props.templates)}
    </a>
  </div>
);

/**
 * §13's three columns, each row followed by its own hub line. The reachability sits in a
 * spanning row under the values it is about rather than in a fourth column: it is a
 * sentence, and a sentence in a 120px column is unreadable at every width.
 */
const ResourceTable: FC<{ rows: AppResourceRow[] }> = ({ rows }) => (
  <table class="table">
    <thead>
      <tr>
        <th>URI</th>
        <th>Name</th>
        <th>Type</th>
      </tr>
    </thead>
    <tbody>
      {rows.map((row) => (
        <>
          <tr>
            <td class="cell-mono">{row.uri}</td>
            <td>{row.name}</td>
            <td class="cell-muted">{row.mimeType}</td>
          </tr>
          <tr class="row-detail">
            {/* No redaction line here, and that is §13's rule rather than an omission:
                URIs are not bodies, and §20.4 pins what the audit row keeps. */}
            <td colspan={3} class="cell-muted">
              {reachLine(row.reach)}
            </td>
          </tr>
        </>
      ))}
    </tbody>
  </table>
);

/**
 * The two rules a reader would otherwise learn from a `-32601`, verbatim (§13/§20.2). The
 * endpoint is printed whole and copyable — the hub's own origin (§2's `PUBLIC_ORIGIN`,
 * carried in props by the model; never a request header) with this app's user and slug —
 * rather than the literal `<hub>` the board draws (§13, 2026-09-03).
 */
const ResourceRules: FC<{ origin: string; username: string; slug: string }> = ({ origin, username, slug }) => (
  <>
    <p class="note">
      Resources are served on the <strong>scoped</strong> endpoint only —{" "}
      <code class="code-inline">
        {origin}
        {paths.mcpScoped(username, slug)}
      </code>
      . The aggregated endpoint answers <code class="code-inline">-32601</code>, because a URI cannot carry a
      slug prefix and stay the URI the app knows.
    </p>
    <p class="note">
      Grants match resources by <strong>URI</strong>, never by name — a role's resource patterns are URI
      patterns, and templates are matched against their raw <code class="code-inline">uriTemplate</code>.
    </p>
  </>
);

const ResourcesPane: FC<AppDetailProps> = (props) => {
  // The tab decides which listing the table draws; both counts come from the two views
  // beside each other, which is also where the one rail marker's sum comes from.
  const shown = props.tab === "templates" ? props.templates : props.resources;
  return (
    <div class="card card--pad">
      {/* No count beside this title, unlike the other two listings: §13 gives each of the
          two tabs its own count, and a third number here would name a different set. */}
      <div>
        <h2 class="card-title">Resources</h2>
        <p class="card-desc">Readable documents and data the app exposes by URI.</p>
      </div>
      {/* Above the ternary, not inside its listed arm: §13 gives this pane two tabs each
          carrying its own count, and the two halves are two independent reads — one can
          fail while the other lists fine. A tab row that disappeared with the selected
          half would strand the reader on the failure with no way back to the other. */}
      <ResourceTabs {...props} />
      {shown.state === "listed" ? (
        <ResourceTable rows={shown.rows} />
      ) : (
        <FamilyEmpty view={shown} family="resources" header={props.header} csrfToken={props.csrfToken} />
      )}
      <ResourceRules origin={props.hubOrigin} username={props.username} slug={props.header.slug} />
    </div>
  );
};

/* --------------------------------------------------------- roles · about --- */

/**
 * §20.3's canonical read shape, rendered in both directions because the read shape has
 * two: a tools-only role is a bare pattern list and prints as one, every other role is
 * the per-family object and prints its family keys. The page relays `app_get`'s answer —
 * canonicalizing here would be a second normalizer beside `registry`'s.
 */
const RoleRow: FC<{ name: string; patterns: string[] | FamilyPatterns }> = ({ name, patterns }) => (
  <div class="list-item">
    <div class="list-title mono">{name}</div>
    {Array.isArray(patterns) ? (
      <div class="list-meta mono">{patterns.join(", ")}</div>
    ) : (
      <div class="kv">
        {Object.entries(patterns).map(([family, list]) => (
          <div class="kv-row">
            <div class="kv-key mono">{family}</div>
            <div class="mono">{(list ?? []).join(", ")}</div>
          </div>
        ))}
      </div>
    )}
  </div>
);

const RolesPane: FC<AppDetailProps> = (props) => {
  const names = Object.keys(props.roles);
  return (
    <div class="card card--pad">
      <div class="card-head">
        <div>
          <h2 class="card-title">Roles</h2>
          {/* Each kind's own sentence for where a role comes from — and, for the tunneled
              kind alone, §2's trust boundary: the app declared these about itself. */}
          <p class="card-desc">
            {props.header.kind === "tunnel"
              ? "Declared by the app at connect time."
              : "Roles are defined in config (virtual) for proxied apps."}
          </p>
        </div>
      </div>
      {names.length === 0 ? (
        <div class="empty empty--inline">
          <div class="empty-title">No roles declared</div>
          <div class="empty-text">
            Grants fall back to the built-in <code class="code-inline">all</code> role — every tool, present and
            future.
          </div>
        </div>
      ) : (
        <div class="list">
          {names.map((name) => (
            <RoleRow name={name} patterns={props.roles[name]} />
          ))}
        </div>
      )}
      {props.header.kind === "tunnel" ? (
        <p class="note">
          Roles are self-declared by the tunneled app — granting a role trusts the app's declaration.
        </p>
      ) : null}
    </div>
  );
};

/** One row of §13's definition list — a label and whatever `app_get` reported for it. */
const OverviewRow: FC<{ label: string; children?: unknown }> = ({ label, children }) => (
  <div class="kv-row">
    <div class="kv-key">{label}</div>
    <div>{children}</div>
  </div>
);

/** §15's setting, said as §13 asks: which default it sits at, or the bare word where the
 *  owner set it explicitly and naming a default would be false. */
function bodyLogging(overview: AppDetailProps["overview"], kind: AppDetailHeader["kind"]): string {
  const state = overview.logBodies ? "On" : "Off";
  if (!overview.logBodiesIsDefault) return state;
  return `${state} — ${kind === "tunnel" ? "tunneled" : "proxied"} default`;
}

/** §7's configured paths, or the word §13 puts where there are none. */
const Paths: FC<{ paths: string[] }> = ({ paths: found }) =>
  found.length === 0 ? <span class="muted">none</span> : <span class="mono">{found.join(", ")}</span>;

const OverviewPane: FC<AppDetailProps> = (props) => (
  <div class="card card--pad">
    <h2 class="card-title">Overview</h2>
    <div class="kv">
      <OverviewRow label="Slug">
        <span class="mono">{props.header.slug}</span>
      </OverviewRow>
      {/* An absolute date WITH its year, unlike every other stamp on this page: "Last
          seen" is recent by nature so its year is implicit, while an app created in 2025
          and one created this August are the same "Aug 20" to `formatLastSeen`. */}
      <OverviewRow label="Created">{formatStamp(props.overview.createdAt)}</OverviewRow>
      <OverviewRow label="Kind">
        <span class="mono">{props.header.kind}</span>
      </OverviewRow>
      {props.header.kind === "proxy" ? (
        <>
          <OverviewRow label="Endpoint">
            <span class="mono">{props.header.endpoint}</span>
          </OverviewRow>
          <OverviewRow label="Auth">
            <span class="mono">{props.header.authMode}</span>
          </OverviewRow>
          <OverviewRow label="Forward identity">{props.header.forwardIdentity ? "On" : "Off"}</OverviewRow>
        </>
      ) : null}
      <OverviewRow label="Body logging">{bodyLogging(props.overview, props.header.kind)}</OverviewRow>
      <OverviewRow label="Redacted arguments">
        <Paths paths={props.overview.redactedArgs} />
      </OverviewRow>
      <OverviewRow label="Redacted results">
        <Paths paths={props.overview.redactedResults} />
      </OverviewRow>
    </div>
  </div>
);

/* -------------------------------------------------------- agents · token --- */

/** One grant, as §13 spells it: `<role> · <mode>`, with the built-in `all` marked — the
 *  page's rendering of `agent_list`'s own grant string and no second read of anything. */
const GrantChip: FC<{ chip: AppGrantChip }> = ({ chip }) => (
  <>
    <span class="badge badge--mono">
      {chip.role} <span class="muted">· {chip.mode}</span>
    </span>
    {chip.builtin ? <span class="muted">built-in</span> : null}
  </>
);

/**
 * §13's Agents pane, read-only in every sense: the slug and description are TEXT because
 * `/agents/<slug>` is deferred and a link there would be a link to a 404, and there is no
 * **Edit grants** control because the (agent × app) editor is deferred too — which is why
 * the footer states where grants ARE edited (`design/AppDetailPanes.dc.html` draws that
 * control three times; §13 removes it).
 */
const AgentsPane: FC<AppDetailProps> = (props) => (
  <div class="card card--pad">
    <div class="card-head">
      <div>
        <h2 class="card-title">Agents with access</h2>
        <p class="card-desc">Which agents can call this app, and how each granted role runs.</p>
      </div>
    </div>
    {props.agents.length === 0 ? (
      <div class="empty empty--inline">
        <div class="empty-text">No agent holds a grant on this app yet.</div>
      </div>
    ) : (
      <table class="table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>Granted roles</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {props.agents.map((agent) => (
            <tr>
              <td>
                <div class="cell-name mono">
                  <a href={paths.agentDetail(agent.slug)}>{agent.slug}</a>
                </div>
                <div class="list-meta">{agent.description}</div>
              </td>
              <td class="badge-row">
                {agent.chips.map((chip) => (
                  <GrantChip chip={chip} />
                ))}
              </td>
              <td class="cell-actions">
                {/* A LINK, not a form: the editor is a page of its own (§13), so this pane
                    fronts no `grant_set` and the pair's whole set is edited in one place. */}
                <a class="btn btn--ghost btn--sm" href={paths.agentApp(agent.slug, props.header.slug)}>
                  Edit grants
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    <p class="note">Grants are edited per agent × app pair — saving replaces that pair's whole set.</p>
  </div>
);

/**
 * §13's Token pane. A proxied app's is the dimmed entry's own explanation and nothing
 * else — §2's reason, so there is no control to hide and none is drawn; `token_issue`
 * refuses `kind: "app"` on that app for the same reason.
 */
const TokenPane: FC<AppDetailProps> = (props) => (
  <div class="card card--pad">
    <div class="card-head">
      <div>
        <h2 class="card-title">App token</h2>
        {props.header.kind === "tunnel" ? (
          <p class="card-desc">The bot presents this token to dial in. App tokens do not expire.</p>
        ) : null}
      </div>
    </div>
    {props.header.kind === "proxy" ? (
      <div class="empty empty--inline">
        <div class="empty-text">
          Proxied apps hold no tokens — the hub dials the upstream; nothing dials in (§2).
        </div>
      </div>
    ) : (
      <>
        {/* §13: "the same reveal the add-app flow shows" — so it IS that one, Copy button
            and store-it warning included, with the sentence that is true of a ROTATION
            alone added beneath rather than folded into the warning both share. */}
        {props.reveal === null ? null : (
          <TokenReveal token={props.reveal}>
            <p class="note">The previous token keeps working until you revoke it.</p>
          </TokenReveal>
        )}
        {props.tokens.length === 0 ? (
          <div class="empty empty--inline">
            <div class="empty-text">No live key — this app cannot dial in until one is issued.</div>
          </div>
        ) : (
          <table class="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Issued</th>
                <th>Last used</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {props.tokens.map((token) => (
                <tr>
                  <td class="cell-mono">{token.prefix}</td>
                  <td class="cell-muted">{formatLastSeen(token.createdAt, props.now)}</td>
                  <td class="cell-muted">
                    {token.lastUsedAt === null ? "never" : formatLastSeen(token.lastUsedAt, props.now)}
                  </td>
                  <td class="cell-actions">
                    {/* Behind the dialog §13 gives it, so the destructive form exists only
                        under the pane's own `?confirm=` URL. */}
                    <a
                      class="btn btn--danger-outline btn--sm"
                      href={paths.appConfirm(props.header.slug, "token", "revoke-token", token.id)}
                    >
                      Revoke
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* The one mutation on this page that answers 200 rather than the generic
            redirect-back: a plaintext key must never ride a URL (§15), so the reveal is
            rendered in place by a route of its own. */}
        <form
          method="post"
          action={paths.appOp(props.header.slug, "token_issue", { kind: "app", slug: props.header.slug })}
          class="actions actions--start"
        >
          <input type="hidden" name="csrf" value={props.csrfToken} />
          <button type="submit" class="btn btn--outline btn--sm">
            Issue new token
          </button>
        </form>
      </>
    )}
  </div>
);

/* ------------------------------------------------------------ danger zone --- */

/** One danger-zone control: what it does, said in §13's own sentence, and the link that
 *  opens its dialog. Unarchive is the exception §13 makes — it destroys nothing, so it is
 *  the form itself. */
const DangerRow: FC<{ title: string; text: string; children?: unknown }> = ({ title, text, children }) => (
  <div class="list-item">
    <div>
      <div class="list-title">{title}</div>
      <div class="list-meta">{text}</div>
    </div>
    <div class="actions">{children}</div>
  </div>
);

const DangerPane: FC<AppDetailProps> = (props) => (
  <div class="card card--pad">
    <h2 class="card-title">Danger zone</h2>
    <div class="list">
      {props.header.archived ? (
        <DangerRow
          title="Unarchive this app"
          text="It accepts connections again, with everything it kept while archived."
        >
          <form method="post" action={paths.appOp(props.header.slug, "app_unarchive", { slug: props.header.slug })}>
            <input type="hidden" name="csrf" value={props.csrfToken} />
            <button type="submit" class="btn btn--outline btn--sm">
              Unarchive
            </button>
          </form>
        </DangerRow>
      ) : (
        <DangerRow
          title="Archive this app"
          text="It refuses connections and leaves the list — tokens, grants and history are kept."
        >
          <a class="btn btn--outline btn--sm" href={paths.appConfirm(props.header.slug, "danger", "archive")}>
            Archive
          </a>
        </DangerRow>
      )}
      <DangerRow
        title="Delete this app"
        text="Revokes its tokens, closes the live connection and removes every grant. This cannot be undone."
      >
        <a class="btn btn--danger-outline btn--sm" href={paths.appConfirm(props.header.slug, "danger", "delete")}>
          Delete
        </a>
      </DangerRow>
    </div>
  </div>
);

/* ---------------------------------------------------------------- dialogs --- */

const DIALOG_ID = "confirm-app";

/**
 * The three destructive confirmations `/apps/<slug>` raises, as server-rendered
 * `<dialog open>` state — so each works with scripting off and is reachable from a URL, a
 * fixture and a bookmark alike. Every one rides, and cancels back to, the pane that drew
 * its control (§13's "confirm-dialog state rides the owning pane's URL").
 */
const AppConfirmDialog: FC<{ confirm: AppConfirm; slug: string; csrfToken: string }> = ({
  confirm,
  slug,
  csrfToken,
}) => {
  const pane = paths.appPane(slug, APP_CONFIRM_PANE[confirm.kind]);
  let title: string;
  let text: string;
  let action: string;
  let word: string;
  if (confirm.kind === "revoke-token") {
    title = `Revoke “${confirm.prefix}”?`;
    text = "Revoking closes the app's live connection.";
    action = paths.appOp(slug, "token_revoke", { id: confirm.id });
    word = "Revoke";
  } else if (confirm.kind === "archive") {
    title = `Archive “${slug}”?`;
    text = "It refuses connections and leaves the list — tokens, grants and history are kept.";
    action = paths.appOp(slug, "app_archive", { slug });
    word = "Archive";
  } else {
    title = `Delete “${slug}”?`;
    text = "Revokes its tokens, closes the live connection and removes every grant. This cannot be undone.";
    action = paths.appOp(slug, "app_delete", { slug });
    word = "Delete";
  }
  return (
    <ConfirmShell id={DIALOG_ID} title={title} text={text}>
      <form method="post" action={action} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        <a class="btn btn--ghost" href={pane}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          {word}
        </button>
      </form>
    </ConfirmShell>
  );
};

/* ------------------------------------------------------------- the panes --- */

const Pane: FC<AppDetailProps> = (props) => {
  if (props.pane === "tools") return <ToolsPane {...props} />;
  if (props.pane === "prompts") return <PromptsPane {...props} />;
  if (props.pane === "resources") return <ResourcesPane {...props} />;
  if (props.pane === "roles") return <RolesPane {...props} />;
  if (props.pane === "overview") return <OverviewPane {...props} />;
  if (props.pane === "access") return <AgentsPane {...props} />;
  if (props.pane === "token") return <TokenPane {...props} />;
  return <DangerPane {...props} />;
};

/* ------------------------------------------------------------------ page --- */

export const AppDetailPage: FC<AppDetailProps> = (props) => {
  const entries = paneEntries(props);
  return (
    <Layout
      title={`${props.header.name} · personal-mcps`}
      active={props.section}
      username={props.username}
      pendingApprovals={props.pendingApprovals}
    >
      <main class="page page--paned">
        <p class="note">
          <a href={paths.apps}>Apps</a> / {props.header.slug}
        </p>

        <div class="page-head">
          {/* Name and badges on ONE line (AppDetail.dc.html): the kind and the status read
              as part of the name, not as a caption under it. */}
          <div class="title-row">
            <h1 class="page-title">{props.header.name}</h1>
            <HeaderBadges header={props.header} />
          </div>
          {props.header.kind === "tunnel" ? (
            <p class="note">Last seen {formatLastSeen(props.header.lastSeen, props.now)}</p>
          ) : null}
        </div>

        <PanePills label={PILL_NAV_LABEL} entries={entries} />

        {/* §13's archived banner, on every pane rather than on the danger zone alone: an
            archived app's page stays reachable and everything on it is still listed, so
            the one thing a reader needs on any of them is why nothing connects. */}
        {props.header.archived ? (
          <div class="alert alert--warning" role="status">
            <div class="alert-text">
              Archived apps refuse connections; everything is kept — tokens, grants and audit history.
            </div>
          </div>
        ) : null}

        {props.notice === null ? null : (
          <div class={alertClass(props.notice.tone)} role={props.notice.tone === "danger" ? "alert" : "status"}>
            <div>
              {props.notice.title === undefined ? null : <div class="alert-title">{props.notice.title}</div>}
              <div class="alert-text">{props.notice.message}</div>
            </div>
          </div>
        )}

        <div class="paned">
          <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
          <div class="pane">
            {props.header.kind === "proxy" ? (
              // §13 gives the endpoint, auth mode and forward identity to the header AND
              // to Overview, so on that one pane the card's rows would be the pane's own
              // rows printed again with nothing between them. The pane wins there; the
              // controls stay, because they belong to the header on all eight.
              <UpstreamCard header={props.header} csrfToken={props.csrfToken} rows={props.pane !== "overview"} />
            ) : null}
            <Pane {...props} />
          </div>
        </div>

        {props.confirm === null ? null : (
          <AppConfirmDialog confirm={props.confirm} slug={props.header.slug} csrfToken={props.csrfToken} />
        )}
      </main>
    </Layout>
  );
};
