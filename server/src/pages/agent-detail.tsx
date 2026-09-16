// agent-detail.tsx — /agents/<slug>: the agent's apps and its own holdings behind the
// same rail /apps/<slug> uses (the `AgentDetail`, `AgentDetailPanes` and
// `AgentDetailStates` boards, 2026-09-16).
//
// Pure: (props) => JSX. Every URL comes from `paths`, every count from the very list its
// pane draws, and the render instant arrives as `now` — so a pane renders identically from
// a fixture and from a request (model.ts's two template rules).
//
// ONE component draws the header, both navigations and whichever pane the URL asked for,
// because §13 makes them one page: the rail's markers are read from the same props the
// pane is, so they cannot disagree with it. `props.pane.kind` says which pane; the header
// and the navigations are identical on all of them, which is what makes the landing render
// (the first granted app, in place) the same response shape as every other.
//
// The app pane is ONE `<form method="post">` per (agent × app) pair: every row's three-way
// control is a radio group named `e.<entry>`, so the browser submits exactly one mode per
// entry and `grant_set` replaces the pair's whole set with what the form composed. That is
// also why the filter above it is a form of its OWN (a GET, whose `q` is the page's input):
// forms do not nest, and the filter must not carry the grant set with it.
//
// The details column carries no control. An entry has exactly one radio group on the page
// — its listing row's — because two groups of one name would submit two values for one
// entry; model.ts's `AgentDetailsView` is the home of that decision.

import type { FC } from "hono/jsx";
import { ConfirmShell, Layout, PaneRail, TokenReveal, paneGroups } from "./layout";
import type { PaneEntry } from "./layout";
import { alertClass, formatLastSeen, formatStamp, formatUntil } from "./format";
import { DIMMED, entryField, paths } from "./model";
import type {
  AgentActivityDetails,
  AgentApprovalRow,
  AgentCallRow,
  AgentClientRow,
  AgentConfirm,
  AgentCredentialsDetails,
  AgentDetailProps,
  AgentDetailsView,
  AgentGrantCard,
  AgentLevelHeader,
  AgentListGroup,
  AgentListRow,
  AgentPaneView,
  AgentRailEntry,
  AgentTokenRow,
  FamilyReach,
  RowControl,
} from "./model";
import { DELETE_AGENT_TEXT } from "./agents";
import { NO_BODIES_SENTENCE } from "./audit";
import { inlineMarkdown, plainText, renderMarkdown } from "./markdown";
import { raw } from "hono/html";

/** The accessible name of this page's pane navigation. The pill row every OTHER paned page
 *  draws below the breakpoint is deliberately absent here: this page's narrow level 1 is
 *  the rail itself, as a list, which is the same destinations said once. */
const RAIL_NAV_LABEL = "Agent panes";

const DIALOG_ID = "confirm-agent";

/** The danger zone's own sentence — longer than the list's, because this card is where the
 *  cascade into clients is stated (the `AgentDetailPanes` board). */
const DELETE_AGENT_FULL =
  "Deleting an agent deletes its tokens, revokes its clients and removes its grants everywhere. This cannot be undone.";

/* ------------------------------------------------------------------ rail --- */

function paneEntries(rail: AgentRailEntry[]): PaneEntry[] {
  return rail.map((entry) => ({
    href: entry.href,
    label: entry.label,
    short: entry.label,
    // The amber dot is a STATUS, not a count, so it is drawn where there is no count to
    // draw — an app entry. An entry carrying a number (Activity's pending, Credentials'
    // pair) prints it, because the number says more than the dot would.
    marker:
      entry.marker === ""
        ? entry.warn
          ? { text: "asks first", dot: "warn" as const }
          : null
        : { text: entry.marker, dim: entry.dim || entry.marker === DIMMED },
    current: entry.current,
    group: entry.group,
  }));
}

/* ------------------------------------------------------------ the control --- */

/** The three buttons, in the order the boards fix them, with the mode each submits. */
const SEGMENTS: { value: "none" | "approval" | "allow"; label: string; rank: number }[] = [
  { value: "none", label: "none", rank: 0 },
  { value: "approval", label: "ask", rank: 1 },
  { value: "allow", label: "allow", rank: 2 },
];

const RANK: Record<string, number> = { none: 0, approval: 1, allow: 2 };

/**
 * One row's three-way control: three radios in a `.seg`, the checked one being the DIRECT
 * entry's mode. Where the rest of the set already grants more than this row does, the
 * implied button is drawn hollow and everything below it is disabled — lowering it means
 * lowering the entry that grants it, which is what the disabled button's title says.
 *
 * One exception to "below the implied mode is disabled": the segment that is checked AND
 * carries an entry. A disabled radio submits nothing and `grant_set` replaces the pair's
 * whole set, so disabling it would make plain Save delete the very entry the row is drawn
 * to show — the direct ask under an allowing role, which the `ask entry · no effect` badge
 * exists to keep. A checked `none` needs no exception: it submits nothing either way.
 */
const Seg: FC<{ control: RowControl }> = ({ control }) => {
  const impliedRank = control.implied === null ? -1 : RANK[control.implied];
  const title = `${control.impliedBy.join(", ")} grants ${control.implied === "allow" ? "allow" : "ask"} — change the role to lower it`;
  return (
    <span class="seg">
      {SEGMENTS.map((segment) => {
        const checked = control.value === segment.value;
        const held = checked && control.value !== "none";
        const disabled = segment.rank < impliedRank && !held;
        const implied = segment.rank === impliedRank && !checked;
        // Amber marks ASK, and only where ask is the state being shown — a live-but-unset
        // ask button is not a warning about anything.
        const warn = segment.value === "approval" && (checked || implied);
        return (
          <label
            class={`seg-opt${implied ? " impl" : ""}${warn ? " seg-opt--warn" : ""}`}
            title={disabled ? title : undefined}
          >
            {/* The title sits on the input as well: a pointer reaches the label, a
                keyboard reaches the input, and both are owed the reason. */}
            <input
              type="radio"
              name={control.field}
              value={segment.value}
              checked={checked}
              disabled={disabled}
              title={disabled ? title : undefined}
            />
            <span>{segment.label}</span>
          </label>
        );
      })}
    </span>
  );
};

/** The arrow that marks a link leaving this page for another — decoration beside words
 *  that already say where it goes, so it is hidden from anyone listing the page's links. */
const IconExternal: FC = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M7 17 17 7" />
    <path d="M7 7h10v10" />
  </svg>
);

/** The `×` beside a badge: a submit button naming the entry to drop, so it works with
 *  scripting off and rides the same Save the radios do. */
const DropButton: FC<{ entry: string }> = ({ entry }) => (
  <button type="submit" class="badge-x" name="drop" value={entry} title="remove this entry">
    ×
  </button>
);

/* ----------------------------------------------------------- the app pane --- */

const Row: FC<{ row: AgentListRow; href: (sel: string) => string }> = ({ row, href }) => {
  if (row.kind === "undeclared") {
    return (
      <div class="cr">
        <div>
          <span class="mono">{row.entry}</span> <span class="badge badge--warning">undeclared</span>
          <div class="cr-detail">granted, but the app has not declared it — dormant</div>
        </div>
        <div class="cr-control">
          {/* No radio here, so the entry would vanish on Save: the hidden field is what
              keeps it, and the × is the only way to let it go. */}
          <input type="hidden" name={entryField(row.entry)} value={row.standing} />
          <span class={row.standing === "allow" ? "badge badge--success" : "badge badge--warning"}>
            {row.standing === "allow" ? "in Allowed" : "in Ask first"}
            <DropButton entry={row.entry} />
          </span>
        </div>
      </div>
    );
  }
  if (row.kind === "role") {
    return (
      <div class="cr">
        <div>
          <a class="row-link mono" href={href(row.sel)}>
            {row.entry}
          </a>
          {row.builtin ? <> <span class="badge badge--muted">built-in</span></> : null}
          <div class="cr-detail">{row.detail}</div>
        </div>
        <div class="cr-control">
          <Seg control={row.control} />
        </div>
      </div>
    );
  }
  if (row.kind === "pattern") {
    return (
      <div class="cr">
        <div>
          <a class="row-link mono" href={href(row.sel)}>
            {row.entry}
          </a>
          <div class={row.dormant ? "cr-detail cr-detail--warn" : "cr-detail"}>{row.detail}</div>
        </div>
        <div class="cr-control">
          <Seg control={row.control} />
        </div>
      </div>
    );
  }
  return (
    <div class="cr">
      <div>
        <a class="row-link mono" href={href(row.sel)}>
          {row.name}
        </a>
        {/* The app's own Markdown, inline only: a row is one line high, and a fence or a
            list in a description must not be allowed to make it three (markdown.ts). */}
        <div class="cr-detail md">{raw(inlineMarkdown(row.description))}</div>
      </div>
      <div class="cr-control">
        {row.noEffect ? (
          <span class="badge badge--warning" title="allow wins over ask">
            ask entry · no effect
            <DropButton entry={row.entry} />
          </span>
        ) : null}
        {row.via.length === 0 ? null : (
          <span class="via">
            {row.alsoVia ? "also via" : "via"} {row.via.join(", ")}
          </span>
        )}
        <Seg control={row.control} />
      </div>
    </div>
  );
};

const Group: FC<{ group: AgentListGroup; href: (sel: string) => string }> = ({ group, href }) => (
  <>
    {group.title === "" ? null : (
      <div class="gh">
        <span>
          {group.title}
          {group.count === "" ? null : ` · ${group.count}`}
        </span>
        {group.note === "" ? null : <span class="gh-note">{group.note}</span>}
      </div>
    )}
    {group.state === null ? group.rows.map((row) => <Row row={row} href={href} />) : <p class="note gh-state">{group.state}</p>}
  </>
);

/** `<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources`. */
function reachLine(agent: string, reach: { tools: FamilyReach; prompts: FamilyReach; resources: FamilyReach }): string {
  return `${agent} reaches ${reach.tools.reached} of ${reach.tools.total} tools · ${reach.tools.approval} ask first · ${reach.prompts.reached} of ${reach.prompts.total} prompts · ${reach.resources.reached} of ${reach.resources.total} resources`;
}

const AppPane: FC<{ props: AgentDetailProps; pane: AgentPaneView & { kind: "app" } }> = ({ props, pane }) => {
  const agent = props.header.slug;
  const base = paths.agentApp(agent, pane.app);
  const href = (sel: string): string =>
    `${base}?${new URLSearchParams(pane.q === "" ? { sel } : { q: pane.q, sel })}`;
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row">
            <span class="listing-title">{pane.appName}</span>
            <span class="badge badge--mono">{pane.app}</span>
            <span class="badge badge--mono">{pane.appKind}</span>
            {pane.status === null ? null : <span class="badge badge--muted">{pane.status}</span>}
          </div>
          <div class="sum">
            {pane.newGrant ? <span class="badge badge--warning badge--dashed">new grant · nothing saved yet</span> : null}
            {reachLine(agent, pane.reach)}
          </div>
          {/* Its own form, and a GET: the filter is a READ control, and a form cannot
              nest inside the Save form below it. */}
          <form method="get" action={base} class="lh-filter">
            <input type="search" name="q" value={pane.q} placeholder="filter, or type a pattern…" aria-label="Filter" />
          </form>
        </div>

        {pane.error === null ? null : (
          <div class="alert alert--danger" role="alert">
            <div class="alert-text">{pane.error}</div>
          </div>
        )}

        <form method="post" action={paths.agentGrantSet(agent, pane.app)} class="listing-form">
          <input type="hidden" name="csrf" value={props.csrfToken} />
          <div class="scroll">
            {pane.groups.map((group) => (
              <Group group={group} href={href} />
            ))}
            {pane.offer === null ? null : (
              <>
                <div class="gh">
                  <span>As a pattern</span>
                </div>
                <div class="cr">
                  <div>
                    <span class="mono">{pane.offer.entry}</span>
                    <div class="cr-detail">{pane.offer.detail}</div>
                  </div>
                  <div class="cr-control">
                    <input type="hidden" name="add" value={pane.offer.entry} />
                    <button type="submit" class="btn btn--outline btn--sm" name="mode" value="approval">
                      Ask
                    </button>
                    <button type="submit" class="btn btn--outline btn--sm" name="mode" value="allow">
                      Allow
                    </button>
                  </div>
                </div>
              </>
            )}
            {pane.nothingMatches ? <p class="note gh-state">Nothing matches “{pane.q}”.</p> : null}
          </div>
          {/* What this render drew no control for still belongs to the set, and Save
              replaces the set whole — so it rides along as a hidden field. */}
          {pane.carry.map((field) => (
            <input type="hidden" name={field.field} value={field.value} />
          ))}
          <div class="save">
            <a class="btn btn--danger-outline btn--sm" href={paths.agentConfirm(base, "remove-app")}>
              Remove from {agent}
            </a>
            <span class="save-end">
              <span class="muted">
                saved · {pane.saved.allow} allow · {pane.saved.approval} ask
              </span>
              <a class="btn btn--ghost btn--sm" href={base}>
                Discard
              </a>
              <button type="submit" class="btn btn--primary btn--sm">
                Save
              </button>
            </span>
          </div>
        </form>
      </div>
      <Details view={pane.details} agent={agent} />
    </>
  );
};

/* ------------------------------------------------------- the details pane --- */

const Kv: FC<{ k: string; children?: unknown }> = ({ k, children }) => (
  <div class="kv-row">
    <div class="kv-key">{k}</div>
    <div>{children}</div>
  </div>
);

const Details: FC<{ view: AgentDetailsView; agent: string }> = ({ view, agent }) => {
  if (view.kind === "none") {
    return (
      <div class="details">
        <div class="dh">
          <div class="title-row">
            <span class="listing-title">{view.appName}</span>
            <span class="badge badge--mono">{view.appKind}</span>
          </div>
          <p class="note">Select a role, tool, prompt or resource on the left for its details.</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">Catalog</div>
            <div class="kv">
              <Kv k="Tools">
                {view.catalog.tools.total} · {view.catalog.tools.reached} reached by {agent}
              </Kv>
              <Kv k="Prompts">
                {view.catalog.prompts.total} · {view.catalog.prompts.reached} reached
              </Kv>
              <Kv k="Resources">
                {view.catalog.resources.total} · {view.catalog.resources.reached} reached
              </Kv>
              <Kv k="Roles">{view.catalog.roles.length === 0 ? "none declared" : view.catalog.roles.join(", ")}</Kv>
            </div>
          </section>
          <section class="card card--pad">
            <div class="eyebrow">Grant set for {agent}</div>
            <div class="kv">
              <Kv k="Allowed">{view.allowed.length === 0 ? "nothing" : view.allowed.join(", ")}</Kv>
              <Kv k="Ask first">{view.askFirst.length === 0 ? "nothing" : view.askFirst.join(", ")}</Kv>
            </div>
          </section>
        </div>
      </div>
    );
  }
  if (view.kind === "role") {
    return (
      <div class="details">
        <div class="dh">
          <div class="title-row">
            <span class="listing-title mono">{view.entry}</span>
            <span class="badge badge--muted">role</span>
          </div>
          <p class="note">{view.source}</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">For {agent}</div>
            <div class="kv">
              <Kv k="Standing">
                {view.standing === "allow" ? "in Allowed" : view.standing === "approval" ? "in Ask first" : "not granted"}
              </Kv>
            </div>
          </section>
          <section class="card card--pad">
            <div class="eyebrow">Patterns</div>
            <div class="kv">
              {view.patterns.map(([family, patterns]) => (
                <Kv k={family}>
                  <span class="mono">{patterns.join(", ")}</span>
                </Kv>
              ))}
            </div>
          </section>
          <section class="card card--pad">
            <div class="eyebrow">Matches today</div>
            <div class="kv">
              {view.matches.map(([family, names]) => (
                <Kv k={family}>{names.length === 0 ? "none" : names.join(", ")}</Kv>
              ))}
            </div>
          </section>
          <p class="note">
            A role widens when the app widens it. To keep a single item regardless, add it directly from its row.
          </p>
        </div>
      </div>
    );
  }
  if (view.kind === "pattern") {
    return (
      <div class="details">
        <div class="dh">
          <div class="title-row">
            <span class="listing-title mono">{view.entry}</span>
            <span class="badge badge--muted">pattern</span>
          </div>
          <p class="note">{"An entry that is not one item: anchored, * aliases .*."}</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">For {agent}</div>
            <div class="kv">
              <Kv k="Standing">{view.standing === "allow" ? "in Allowed" : "in Ask first"}</Kv>
            </div>
          </section>
          <section class="card card--pad">
            <div class="eyebrow">Matches today · {view.matches.length}</div>
            {view.matches.length === 0 ? (
              <p class="note">nothing — kept, dormant</p>
            ) : (
              view.matches.map((name) => <div class="mono">{name}</div>)
            )}
          </section>
        </div>
      </div>
    );
  }
  return (
    <div class="details">
      <div class="dh">
        <div class="title-row">
          <span class="listing-title mono">{view.name}</span>
          <span class="badge badge--muted">{view.family}</span>
        </div>
        {view.description === "" ? null : <div class="note md">{raw(renderMarkdown(view.description))}</div>}
      </div>
      <div class="db">
        <section class="card card--pad">
          <div class="eyebrow">For {agent}</div>
          <div class="kv">
            <Kv k="Standing">{view.standing}</Kv>
            <Kv k="Approval">{view.approval}</Kv>
          </div>
        </section>
        {view.args === null ? null : (
          <section class="card card--pad">
            <div class="eyebrow">Arguments</div>
            {view.args.length === 0 ? (
              <p class="note">none</p>
            ) : (
              <div class="kv">
                {view.args.map((arg) => (
                  <Kv k={arg.name}>
                    {arg.type === "" ? "" : `${arg.type} · `}
                    {arg.required ? "required" : "optional"}
                  </Kv>
                ))}
              </div>
            )}
          </section>
        )}
        {view.hub === null ? null : (
          <section class="card card--pad">
            <div class="eyebrow">What only the hub knows</div>
            <div class="kv">
              <Kv k="Called as">
                <span class="mono">{view.hub.aggregated}</span> on the aggregated endpoint
              </Kv>
              <Kv k="Reachable by">{view.hub.reachableBy}</Kv>
              <Kv k="Redaction">{view.hub.redaction}</Kv>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};

/* --------------------------------------------------------- the grant step --- */

const GrantCard: FC<{ card: AgentGrantCard; agent: string; q: string }> = ({ card, agent, q }) => {
  const base = paths.agentPane(agent, "grant");
  const toggle = new URLSearchParams(card.open ? {} : { show: card.slug });
  if (q !== "") toggle.set("q", q);
  const toggleHref = `${base}${toggle.toString() === "" ? "" : `?${toggle}`}`;
  return (
    <div class="appcard">
      <div class="appcard-main">
        <div class="title-row">
          <span class="listing-title">{card.name}</span>
          <span class="badge badge--mono">{card.slug}</span>
          <span class="badge badge--mono">{card.kind}</span>
          {card.status === null ? null : <span class="badge badge--muted">{card.status}</span>}
        </div>
        {card.description === "" ? null : <div>{card.description}</div>}
        <div class="note">
          {card.counts === "" ? null : `${card.counts} · `}roles{" "}
          {card.roles.length === 0 ? "none" : card.roles.join(", ")} · <a href={toggleHref}>{card.toggle}</a>
        </div>
        {card.open ? (
          <div class="eps">
            {card.endpoints.map((endpoint) => (
              <div class="ep">
                <div>
                  <span class="ep-family">{endpoint.family}</span>
                  <span class="mono">{endpoint.name}</span>
                  {endpoint.description === "" ? null : (
                    // An attribute holds text and nothing else, so the Markdown comes OFF
                    // here rather than rendering — a `title` cannot carry a fence.
                    <span class="ep-info" title={plainText(endpoint.description)} aria-label={plainText(endpoint.description)}>
                      i
                    </span>
                  )}
                </div>
                <div class="ep-roles">
                  {endpoint.roles.length === 0 ? (
                    <span class="muted">only via all or by name</span>
                  ) : (
                    endpoint.roles.map((role) => <span class="badge badge--mono">{role}</span>)
                  )}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <div class="appcard-end">
        <a class="btn btn--primary btn--sm" href={paths.agentApp(agent, card.slug)}>
          Grant
        </a>
      </div>
    </div>
  );
};

const GrantPane: FC<{ agent: string; pane: AgentPaneView & { kind: "grant" } }> = ({ agent, pane }) => (
  <div class="listing listing--wide">
    <div class="lh">
      <div class="title-row">
        <span class="listing-title">Grant another app</span>
        <span class="note">apps {agent} holds nothing on</span>
      </div>
      <form method="get" action={paths.agentPane(agent, "grant")} class="lh-filter">
        <input type="search" name="q" value={pane.q} placeholder="search apps and endpoints…" aria-label="Search" />
      </form>
      <div class="sum">
        What each app does; open it to see every endpoint and which roles grant it. Grant opens the app with nothing
        granted yet.
      </div>
    </div>
    <div class="scroll">
      {pane.total === 0 ? (
        <p class="note gh-state">
          {agent} already holds a grant on every active app. Archived apps are not listed; unarchive one to grant it.
        </p>
      ) : (
        <>
          <div class="gh">
            <span>Apps · {pane.cards.length === pane.total ? pane.total : `${pane.cards.length} of ${pane.total}`}</span>
            <span class="gh-note">active, not archived · nothing is written until you save</span>
          </div>
          {pane.cards.map((card) => (
            <GrantCard card={card} agent={agent} q={pane.q} />
          ))}
        </>
      )}
    </div>
  </div>
);

/* -------------------------------------------------------- the credentials --- */

/** §8's four expiries, as the control beside Issue offers them. `never` is the op's own
 *  word for "no expiry", passed through unchanged. */
const EXPIRIES: { value: string; label: string }[] = [
  { value: "2592000", label: "30d" },
  { value: "7776000", label: "90d · default" },
  { value: "31536000", label: "1y" },
  { value: "never", label: "never" },
];

/** `Nov 10 (90 d)` — the expiry date and the LIFETIME it was issued for, which is the
 *  thing an owner compares keys by; `never` for a key with no expiry at all. */
function expiryText(row: AgentTokenRow): string {
  if (row.expiresAt === null) return "never";
  const days = Math.round((row.expiresAt - row.createdAt) / 86_400_000);
  return `${formatStamp(row.expiresAt)} (${days} d)`;
}

const TokenRow: FC<{ row: AgentTokenRow; agent: string; now: string; isNew: boolean }> = ({ row, agent, now, isNew }) => {
  const base = paths.agentPane(agent, "credentials");
  return (
    <div class={row.expired ? "cr cr--dim" : "cr"}>
      <div>
        <a class="row-link mono" href={`${base}?sel=token:${row.id}`}>
          {row.prefix}
        </a>
        {row.expired ? <> <span class="badge badge--warning">expired</span></> : null}
        {isNew ? <> <span class="badge badge--success badge--dashed">new</span></> : null}
        <div class="cr-detail">
          created {formatStamp(row.createdAt)} · expires {expiryText(row)} · used{" "}
          {row.lastUsedAt === null ? "never" : formatLastSeen(row.lastUsedAt, now)}
        </div>
      </div>
      <div class="cr-control">
        <a
          class="btn btn--danger-outline btn--sm"
          href={paths.agentConfirm(base, row.expired ? "remove-token" : "revoke-token", row.id)}
        >
          {row.expired ? "Remove" : "Revoke"}
        </a>
      </div>
    </div>
  );
};

const ClientRow: FC<{ row: AgentClientRow; agent: string; now: string }> = ({ row, agent, now }) => (
  <div class="cr">
    <div>
      <a class="row-link" href={`${paths.agentPane(agent, "credentials")}?sel=client:${row.id}`}>
        {row.name}
      </a>{" "}
      <span class="mono muted">{row.origin}</span>
      <div class="cr-detail">
        consented {formatStamp(row.createdAt)} · used {row.lastUsedAt === null ? "never" : formatLastSeen(row.lastUsedAt, now)}
      </div>
    </div>
    <div class="cr-control">
      <span class={row.revoked ? "badge badge--muted" : "badge badge--success"}>{row.revoked ? "revoked" : "active"}</span>
    </div>
  </div>
);

const CredentialsDetails: FC<{ view: AgentCredentialsDetails; now: string }> = ({ view, now }) => {
  if (view.kind === "none") {
    return (
      <div class="details">
        <div class="dh">
          <div class="listing-title">Credentials</div>
          <p class="note">Select a token or a client for its details.</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">Summary</div>
            <div class="kv">
              <Kv k="Tokens">{view.tokens}</Kv>
              <Kv k="Clients">{view.clients}</Kv>
            </div>
          </section>
        </div>
      </div>
    );
  }
  if (view.kind === "client") {
    return (
      <div class="details">
        <div class="dh">
          <div class="title-row">
            <span class="listing-title">{view.row.name}</span>
            <span class="badge badge--muted">OAuth client</span>
          </div>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">This client</div>
            <div class="kv">
              <Kv k="Redirect origin">
                <span class="mono">{view.row.origin}</span>
              </Kv>
              <Kv k="Consented">{formatStamp(view.row.createdAt)}</Kv>
              <Kv k="Last used">
                {view.row.lastUsedAt === null ? "never" : formatLastSeen(view.row.lastUsedAt, now)}
              </Kv>
              <Kv k="Registered">
                {view.row.selfRegistered ? "registered itself — identity unverified" : "by you, at consent"}
              </Kv>
            </div>
          </section>
        </div>
      </div>
    );
  }
  return (
    <div class="details">
      <div class="dh">
        <div class="title-row">
          <span class="listing-title mono">{view.row.prefix}</span>
          <span class="badge badge--muted">token</span>
        </div>
      </div>
      <div class="db">
        <section class="card card--pad">
          <div class="eyebrow">This key</div>
          <div class="kv">
            <Kv k="Created">{formatStamp(view.row.createdAt)}</Kv>
            <Kv k="Expires">{view.row.expiresAt === null ? "never" : formatStamp(view.row.expiresAt)}</Kv>
            <Kv k="Last used">
              {view.row.lastUsedAt === null ? "never" : formatLastSeen(view.row.lastUsedAt, now)}
            </Kv>
            <Kv k="Carries">every grant in the Apps list — a key is the agent, not a subset of it</Kv>
          </div>
        </section>
        <section class="card card--pad">
          {/* Named for what it actually is: the ledger records a principal, never which
              credential presented it, so this is the agent's traffic, not this key's. */}
          <div class="eyebrow">Recent use · the agent's last three calls</div>
          {view.recent.length === 0 ? (
            <p class="note">no calls yet</p>
          ) : (
            <div class="kv">
              {view.recent.map((call) => (
                <Kv k={formatLastSeen(call.ts, now)}>
                  <span class="mono">{call.app}</span> · <span class="mono">{call.tool}</span>
                </Kv>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

const CredentialsPane: FC<{ props: AgentDetailProps; pane: AgentPaneView & { kind: "credentials" } }> = ({ props, pane }) => {
  const agent = props.header.slug;
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row">
            <span class="listing-title">Credentials</span>
            <span class="note">what {agent} presents to get in</span>
          </div>
          <div class="sum">
            Any of these carries the grants in the Apps list. A token expires on its date; a client stays in until
            revoked in Settings.
          </div>
        </div>
        {props.reveal === null ? null : (
          <div class="lh">
            <TokenReveal token={props.reveal}>
              <p class="note">Any earlier key keeps working until you revoke it.</p>
            </TokenReveal>
          </div>
        )}
        <div class="scroll">
          <div class="gh">
            <span>Tokens · {pane.tokens.length}</span>
            {/* The one mutation on this page that answers 200 rather than the
                redirect-back: a plaintext key must never ride a URL (§15), so its own
                route re-renders this pane with the reveal in place. */}
            <form method="post" action={paths.agentOp(agent, "token_issue", { kind: "agent", slug: agent })} class="gh-form">
              <input type="hidden" name="csrf" value={props.csrfToken} />
              <label class="gh-note" for="expires_in">
                expires in
              </label>
              <select id="expires_in" name="expires_in">
                {EXPIRIES.map((option) => (
                  <option value={option.value} selected={option.label.endsWith("default")}>
                    {option.label}
                  </option>
                ))}
              </select>
              <button type="submit" class="btn btn--outline btn--sm">
                Issue token
              </button>
            </form>
          </div>
          {pane.tokens.length === 0 ? (
            <p class="note gh-state">No key yet — this agent cannot call anything until one is issued.</p>
          ) : (
            pane.tokens.map((row) => (
              <TokenRow row={row} agent={agent} now={props.now} isNew={row.id === pane.issuedId} />
            ))
          )}
          <div class="gh">
            <span>Connected clients · {pane.clients.length}</span>
            <span class="gh-note">OAuth · managed in Settings</span>
          </div>
          {pane.clients.map((row) => (
            <ClientRow row={row} agent={agent} now={props.now} />
          ))}
          <p class="note gh-state">
            One OAuth client signs in as this agent, so its calls carry these grants. Revoking lives with the other
            credentials in <a href={paths.settingsClients}>Settings → Connected clients</a>.
          </p>
        </div>
      </div>
      <CredentialsDetails view={pane.details} now={props.now} />
    </>
  );
};

/* ------------------------------------------------------------ the activity --- */

/**
 * One request. A decided one stays listed — dimmed, wearing its status instead of the two
 * buttons — because the row is the evidence that the decision landed; dropping it would
 * read as the request having disappeared.
 */
const ApprovalRowView: FC<{ row: AgentApprovalRow; agent: string; csrfToken: string; now: string }> = ({
  row,
  agent,
  csrfToken,
  now,
}) => (
  <div class={row.status === "pending" ? "cr" : "cr cr--dim"}>
    <div>
      <span class="mono muted">{row.app}</span>{" "}
      <a class="row-link mono" href={`${paths.agentPane(agent, "activity")}?sel=${row.sel}`}>
        {row.tool}
      </a>
      <div class="cr-detail mono">{row.args}</div>
    </div>
    <div class="cr-control">
      <span class="muted">{formatLastSeen(Date.parse(row.createdAt), now)}</span>
      {row.status === "pending" ? (
        <>
          <form method="post" action={paths.agentOp(agent, "approval_decide", { id: row.id, decision: "reject" })}>
            <input type="hidden" name="csrf" value={csrfToken} />
            <button type="submit" class="btn btn--outline btn--sm">
              Reject
            </button>
          </form>
          <form method="post" action={paths.agentOp(agent, "approval_decide", { id: row.id, decision: "approve" })}>
            <input type="hidden" name="csrf" value={csrfToken} />
            <button type="submit" class="btn btn--primary btn--sm">
              Approve
            </button>
          </form>
        </>
      ) : (
        <span class={row.status === "approved" || row.status === "used" ? "badge badge--success" : "badge badge--muted"}>
          {row.status}
        </span>
      )}
    </div>
  </div>
);

/** A call's outcome word as a badge — green for the one that ran, amber for the one the
 *  owner can still act on, red for everything the door refused. */
function outcomeClass(outcome: string): string {
  if (outcome === "ok") return "badge badge--success";
  if (outcome === "approval required") return "badge badge--warning";
  return "badge badge--danger";
}

const ActivityDetails: FC<{ view: AgentActivityDetails; agent: string; csrfToken: string; now: string }> = ({
  view,
  agent,
  csrfToken,
  now,
}) => {
  if (view.kind === "none") {
    return (
      <div class="details">
        <div class="dh">
          <div class="listing-title">Activity</div>
          <p class="note">Select a request or a call for its details.</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">7 days</div>
            <div class="kv">
              <Kv k="Calls">
                {view.calls} · {view.ok} ok
              </Kv>
              <Kv k="Denied">{view.denied}</Kv>
              <Kv k="Awaiting approval">{view.pending}</Kv>
            </div>
          </section>
        </div>
      </div>
    );
  }
  if (view.kind === "approval") {
    return (
      <div class="details">
        <div class="dh">
          <div class="title-row">
            <span class="listing-title mono">{view.row.tool}</span>
            <span class="badge badge--warning">{view.row.status}</span>
          </div>
          <p class="note">
            {agent} wants to call this on <span class="mono">{view.row.app}</span> · asked{" "}
            {formatLastSeen(Date.parse(view.row.createdAt), now)} · expires in{" "}
            {formatUntil(Date.parse(view.row.expiresAt), now)}
          </p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">Arguments · post-redaction</div>
            <pre class="code">{view.row.args}</pre>
          </section>
          {view.why === null ? null : (
            <section class="card card--pad">
              <div class="eyebrow">Why it waits</div>
              <div class="kv">
                <Kv k="Grant">{view.why}</Kv>
              </div>
            </section>
          )}
          <div class="actions actions--start">
            <form method="post" action={paths.agentOp(agent, "approval_decide", { id: view.row.id, decision: "reject" })}>
              <input type="hidden" name="csrf" value={csrfToken} />
              <button type="submit" class="btn btn--outline btn--sm">
                Reject
              </button>
            </form>
            <form method="post" action={paths.agentOp(agent, "approval_decide", { id: view.row.id, decision: "approve" })}>
              <input type="hidden" name="csrf" value={csrfToken} />
              <button type="submit" class="btn btn--primary btn--sm">
                Approve
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div class="details">
      <div class="dh">
        <div class="title-row">
          <span class="listing-title mono">{view.row.tool}</span>
          <span class={outcomeClass(view.row.outcome)}>{view.row.outcome}</span>
        </div>
        <p class="note">
          <span class="mono">{view.row.app}</span> · {formatLastSeen(view.row.ts, now)}
          {view.row.durationMs === null ? "" : ` · ${view.row.durationMs} ms`}
        </p>
      </div>
      <div class="db">
        {view.noBodies === null ? null : (
          <section class="card card--pad">
            {/* The audit page's own three sentences, not a fourth: "no bodies" has three
                causes and telling an owner the wrong one is worse than saying nothing. */}
            <p class="note">{NO_BODIES_SENTENCE[view.noBodies]}</p>
          </section>
        )}
        {view.args === null ? null : (
          <section class="card card--pad">
            <div class="eyebrow">Arguments</div>
            <pre class="code">{view.args}</pre>
          </section>
        )}
        {view.result === null ? null : (
          <section class="card card--pad">
            <div class="eyebrow">Result</div>
            <pre class="code">{view.result}</pre>
          </section>
        )}
        <p class="note">
          The same row the audit page shows.{" "}
          <a href={`${paths.audit}?expand=${view.row.id}#event-${view.row.id}`}>Open in the audit trail</a>.
        </p>
      </div>
    </div>
  );
};

const ActivityPane: FC<{ props: AgentDetailProps; pane: AgentPaneView & { kind: "activity" } }> = ({ props, pane }) => {
  const agent = props.header.slug;
  // Where this pane's window ends and the ledger's begins — named once, because the
  // header offers it and so does the foot of the walk.
  const auditHref = `${paths.audit}?principal=agent:${agent}`;
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row title-row--split">
            <span class="listing-title">Activity</span>
            <span class="note">the last 7 days, the retention window</span>
            {/* The window ends here and the ledger goes on: a control rather than a note,
                because leaving for the full trail is a thing the reader DOES. */}
            <a class="btn btn--outline btn--sm title-row-end" href={auditHref} title={auditHref}>
              Open in Audit
              <IconExternal />
            </a>
          </div>
          {/* `last N` rather than `N`: the ledger counts nothing, so N is what this page
              drew and a bare count would read as the week's total. */}
          <div class="sum">
            last {pane.summary.calls} calls · {pane.summary.ok} ok · {pane.summary.denied} denied ·{" "}
            {pane.summary.pending} awaiting approval
          </div>
        </div>
        <div class="scroll">
          <div class="gh">
            <span>Awaiting approval · {pane.summary.pending}</span>
            <span class="gh-note">each expires an hour after it was asked</span>
          </div>
          {pane.requests.map((row) => (
            <ApprovalRowView row={row} agent={agent} csrfToken={props.csrfToken} now={props.now} />
          ))}
          <div class="gh">
            <span>Recent calls · {pane.calls.length}</span>
            <span class="gh-note">newest first</span>
          </div>
          {pane.calls.map((row) => (
            <div class="cr">
              <div>
                <span class="mono muted">{row.app}</span>{" "}
                <a class="row-link mono" href={`${paths.agentPane(agent, "activity")}?sel=${row.sel}`}>
                  {row.tool}
                </a>
                <div class="cr-detail">
                  {formatLastSeen(row.ts, props.now)}
                  {row.durationMs === null ? "" : ` · ${row.durationMs} ms`}
                </div>
              </div>
              <div class="cr-control">
                <span class={outcomeClass(row.outcome)}>{row.outcome}</span>
              </div>
            </div>
          ))}
          {/* The walk's own foot: a link, never a script, so every page of the week is a
              URL — and it always says something, because "the list stopped" and "the week
              stopped" are different facts and only one of them is the end. */}
          <div class="more">
            {pane.moreHref === null ? (
              <span class="note">
                That is the whole week — older calls are in <a href={auditHref}>Audit</a>.
              </span>
            ) : (
              <>
                <a href={pane.moreHref}>Load 20 more</a>
                <span class="note">
                  more older calls in the last 7 days · everything before that is in{" "}
                  <a href={auditHref}>Audit</a>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
      <ActivityDetails view={pane.details} agent={agent} csrfToken={props.csrfToken} now={props.now} />
    </>
  );
};

/* --------------------------------------------------------- the danger zone --- */

const DangerPane: FC<{ agent: string; pane: AgentPaneView & { kind: "danger" } }> = ({ agent, pane }) => (
  <>
    <div class="listing">
      <div class="lh">
        <span class="listing-title">Danger zone</span>
      </div>
      <div class="scroll">
        <section class="card card--pad card--danger">
          <h2 class="card-title">Delete agent</h2>
          <p class="card-desc">{DELETE_AGENT_FULL}</p>
          <div class="actions actions--start">
            <a class="btn btn--danger-outline" href={paths.agentConfirm(paths.agentPane(agent, "danger"), "delete-agent")}>
              Delete {agent}
            </a>
          </div>
        </section>
      </div>
    </div>
    <div class="details">
      <div class="dh">
        <div class="listing-title">What deletion removes</div>
      </div>
      <div class="db">
        <section class="card card--pad">
          <div class="kv">
            <Kv k="Grants">{pane.grants} apps</Kv>
            <Kv k="Tokens">{pane.tokens}</Kv>
            <Kv k="Clients">{pane.clients} — the binding cascades</Kv>
            <Kv k="History">kept — audit rows name the principal, not the row</Kv>
          </div>
        </section>
      </div>
    </div>
  </>
);

/* ------------------------------------------------------------------ dialog --- */

const AgentDialog: FC<{ confirm: AgentConfirm; props: AgentDetailProps }> = ({ confirm, props }) => {
  const agent = props.header.slug;
  const credentials = paths.agentPane(agent, "credentials");
  const spec =
    confirm.kind === "revoke-token"
      ? {
          title: `Revoke “${confirm.prefix}”?`,
          text: "Calls made with this key fail from now on.",
          action: paths.agentOp(agent, "token_revoke", { id: confirm.id }),
          cancel: credentials,
          verb: "Revoke",
        }
      : confirm.kind === "remove-token"
        ? {
            title: `Remove expired token ${confirm.prefix}?`,
            text: `It expired ${confirm.expiresAt === null ? "already" : formatStamp(confirm.expiresAt)}; removing it keeps its history.`,
            action: paths.agentOp(agent, "token_revoke", { id: confirm.id }),
            cancel: credentials,
            verb: "Remove",
          }
        : confirm.kind === "remove-app"
          ? {
              title: `Remove ${confirm.app} from ${agent}?`,
              text: `${agent} loses every entry on ${confirm.app}. History stays; a waiting request expires.`,
              action: paths.agentGrantSet(agent, confirm.app),
              cancel: paths.agentApp(agent, confirm.app),
              verb: "Remove",
            }
          : {
              title: `Delete agent “${agent}”?`,
              text: DELETE_AGENT_TEXT,
              action: paths.agentOp(agent, "agent_delete", { slug: agent }),
              cancel: paths.agentPane(agent, "danger"),
              verb: "Delete",
            };
  return (
    <ConfirmShell id={DIALOG_ID} title={spec.title} text={spec.text}>
      <form method="post" action={spec.action} class="actions">
        <input type="hidden" name="csrf" value={props.csrfToken} />
        {/* The whole set, cleared: `grant_set` replaces it, so an empty one IS the
            removal — the same op the Save button posts, with nothing to compose. */}
        {confirm.kind === "remove-app" ? <input type="hidden" name="clear" value="1" /> : null}
        <a class="btn btn--ghost" href={spec.cancel}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          {spec.verb}
        </button>
      </form>
    </ConfirmShell>
  );
};

/* -------------------------------------------------------------------- page --- */

/**
 * The narrow level header — one row: the way up on the left, where you are in the middle.
 * In the document on every render at every width and shown only below the breakpoint,
 * where it stands in for the title line and the rail at once (§13's level table).
 *
 * The trailing span is the counterweight that centres the title against the back link;
 * it carries nothing, which is why it is hidden from anyone reading the page's contents.
 */
const LevelHeader: FC<{ header: AgentLevelHeader }> = ({ header }) => (
  <div class="level-header">
    <a class="level-back" href={header.backHref}>
      ‹ {header.backLabel}
    </a>
    <span class="level-title">{header.title}</span>
    <span class="level-end" aria-hidden="true"></span>
  </div>
);

const Pane: FC<{ props: AgentDetailProps }> = ({ props }) => {
  const pane = props.pane;
  if (pane.kind === "app") return <AppPane props={props} pane={pane} />;
  if (pane.kind === "grant") return <GrantPane agent={props.header.slug} pane={pane} />;
  if (pane.kind === "credentials") return <CredentialsPane props={props} pane={pane} />;
  if (pane.kind === "activity") return <ActivityPane props={props} pane={pane} />;
  return <DangerPane agent={props.header.slug} pane={pane} />;
};

/**
 * The whole page, whichever pane it is on: the breadcrumb, the header and its four
 * totals, both pane navigations, the notice, and then `props.pane` — the app pane
 * (listing + details), the grant step, Credentials, Activity or the danger zone.
 *
 * `reveal` is set by ONE route, `token_issue`, which answers 200 rather than redirecting
 * because a plaintext key must never ride a URL (§15). It is therefore only ever drawn on
 * the credentials pane, above the token list; every other render carries null.
 */
export const AgentDetailPage: FC<AgentDetailProps> = (props) => {
  const entries = paneEntries(props.rail);
  const { slug, name, description, createdAt, tiles } = props.header;
  return (
    <Layout
      title={`${slug} · Agents · personal-mcps`}
      active="agents"
      username={props.username}
      pendingApprovals={props.pendingApprovals}
    >
      {/* `data-level` is read by the narrow stylesheet ALONE: it shows one of the rail,
          the listing and the details by it, and the wide one never looks. */}
      <main class="page--workspace" data-level={String(props.level)}>
        <LevelHeader header={props.levelHeader} />
        <div class="page-head">
          <div>
            {/* ONE row: where the page sits, what it is, and what it is for. A crumb on a
                line of its own was a whole line spent saying "Agents", and the pane the
                URL names is already the entry the rail marks — so neither the app nor the
                pane is repeated up here. */}
            <div class="title-row">
              <a class="crumb" href={paths.agents}>
                Agents
              </a>
              <span class="crumb-sep" aria-hidden="true">
                ›
              </span>
              <h1 class="page-title mono">{slug}</h1>
              {description === "" ? null : <span class="page-subtitle">{description}</span>}
            </div>
            {name === slug ? null : <p class="page-subtitle">{name}</p>}
            <p class="page-subtitle">Created {formatStamp(createdAt)}</p>
          </div>
          {/* ONE line, the parts separated by the hub's own middot — four tiles side by
              side would read as four independent facts rather than one partition. */}
          <div class="tiles">
            {`${tiles.apps} apps · ${tiles.allowed} allow · ${tiles.askFirst} ask first · ${tiles.dormant} dormant`}
          </div>
        </div>

        {props.notice === null ? null : (
          <div class={alertClass(props.notice.tone)} role={props.notice.tone === "danger" ? "alert" : "status"}>
            <div>
              {props.notice.title === undefined ? null : <div class="alert-title">{props.notice.title}</div>}
              <div class="alert-text">{props.notice.message}</div>
            </div>
          </div>
        )}

        {/* `--framed`: on THIS page the rail is a column of the three-pane box rather
            than a list standing beside a card (AgentDetail.dc.html) — /settings and
            /apps/<slug> keep the unframed shape. */}
        <div class="paned paned--framed">
          <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
          <div class="pane pane--split">
            <Pane props={props} />
          </div>
        </div>
      </main>
      {props.confirm === null ? null : <AgentDialog confirm={props.confirm} props={props} />}
    </Layout>
  );
};
