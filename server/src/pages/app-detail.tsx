// app-detail.tsx — /apps/<slug>: one app as three panes behind a rail, the shape
// /agents/<slug> already has (the 2026-09-17 dispatch; design/concepts/AppThreePaneDemo.html
// is the visual contract).
//
// Pure: (props) => JSX. Every URL comes from `paths`, every count from the very list its
// pane draws, and the render instant arrives as `now` — so a pane renders identically from
// a fixture and from a request (model.ts's two template rules).
//
// ONE component draws the header, the rail and whichever pane the URL asked for, because
// §13 makes them one page: the rail's markers are read from the same props the pane is, so
// they cannot disagree with it. `props.pane.kind` says which pane; the header and the rail
// are identical on all seven, which is what makes the landing render (Catalog, in place)
// the same response shape as every other.
//
// THREE forms live here, each posting ONE op (§4–§6): the Roles editor
// (`role_set` → `app_update { owner_roles | roles }`), the Recording editor
// (`recording_set` → `app_update { log_bodies, redact, redact_results }`) and the grant
// editor (`grant_set`, the agent page's own composer). Each carries the CSRF field, each
// is redrawn at 400 on a refusal with the submitted choices in place, and none of them
// nests inside another — the filters above them are GET forms of their own, and the two
// controls that must sit in a filter's header (the role name, the recording switch) reach
// their form through HTML's own `form=` attribute rather than by nesting.
//
// The demo has two things this page deliberately does not: the unsaved-changes banner and
// the blue draft dots. Both are script-only state and the pages are server-rendered with
// scripting off, exactly as the agent page dropped them.

import type { FC } from "hono/jsx";
import { ConfirmShell, Layout, LevelHeader, PaneRail, TokenReveal, paneGroups } from "./layout";
import type { PaneEntry } from "./layout";
import { alertClass, formatLastSeen, formatStamp } from "./format";
import { APP_CONFIRM_PANE, DIMMED, paths } from "./model";
import type {
  AgentBadge,
  AppAccessDetails,
  AppCatalogDetails,
  AppCatalogGroup,
  AppConfirm,
  AppDetailHeader,
  AppDetailProps,
  AppPaneView,
  AppRecordingCard,
  AppRecordingSection,
  AppRoleDetails,
  AppRoleRow,
  AppSchemaRow,
  AppTokenRow,
} from "./model";
import { GrantGroup, reachLine } from "./grant-rows";
import { inlineMarkdown, renderMarkdown } from "./markdown";
import { raw } from "hono/html";

/**
 * The accessible name of this page's pane navigation — the rail, which below the
 * breakpoint is the landing level's list (§2's three levels, as the agent page's).
 */
const RAIL_NAV_LABEL = "App panes";

const DIALOG_ID = "confirm-app";

/** The two form ids a control reaches from outside its own parent, HTML's `form=` standing
 *  in for the nesting a filter above the form makes impossible. */
const ROLE_FORM = "role-editor";
const RECORDING_FORM = "recording-editor";

/* ------------------------------------------------------------------ rail --- */

function paneEntries(props: AppDetailProps): PaneEntry[] {
  return props.rail.map((entry) => ({
    href: entry.href,
    label: entry.label,
    short: entry.label,
    marker:
      entry.dot !== null
        ? { text: entry.marker, dot: entry.dot }
        : // The em dash is the ONE marker that means "advertises none" (§2), so it is also
          // the one that draws its entry receded — read from model's own constant.
          entry.marker === ""
          ? null
          : { text: entry.marker, dim: entry.marker === DIMMED },
    current: entry.pane === props.pane.kind,
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

/**
 * The proxied half of §2's header: what the hub dials, how it authenticates, and whether it
 * forwards the caller's identity — plus, for `auth: oauth` alone, the same
 * Connect/Reconnect and Disconnect targets /apps draws.
 *
 * `rows` is off on the Overview pane alone: those three facts belong to the header AND to
 * Overview, so there they would be the pane's own first rows printed again with nothing
 * between them. The controls stay on all seven — they belong to the header, not to a pane.
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

/* ----------------------------------------------------------------- bits --- */

const Kv: FC<{ k: string; children?: unknown }> = ({ k, children }) => (
  <div class="kv-row">
    <div class="kv-key">{k}</div>
    <div>{children}</div>
  </div>
);

/** One agent that reaches a row: mono for allow, amber for `· ask` (§3/§4). */
const Badges: FC<{ badges: AgentBadge[]; empty: string }> = ({ badges, empty }) =>
  badges.length === 0 ? (
    <span class="muted">{empty}</span>
  ) : (
    <>
      {badges.map((badge) => (
        <span class={badge.ask ? "badge badge--warning" : "badge badge--mono"}>
          {badge.ask ? `${badge.agent} · ask` : badge.agent}
        </span>
      ))}
    </>
  );

/** A danger alert above a refused editor — never a redirect, or the choices would be
 *  lost (§4/§5/§6's "400 redraw"). */
const Refusal: FC<{ error: string | null }> = ({ error }) =>
  error === null ? null : (
    <div class="alert alert--danger" role="alert">
      <div class="alert-text">{error}</div>
    </div>
  );

/** The tick glyph both the checkbox's checked state and the locked ticks draw. */
const Check: FC = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** The dash a MIXED path wears: masked on some of its tools, and clearable on none of
 *  them from here (§5's data-safety rule — the rows below it are where it changes). */
const Dash: FC = () => (
  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" aria-hidden="true">
    <path d="M5 12h14" />
  </svg>
);

/* -------------------------------------------------------------- Catalog --- */

const CatalogGroupView: FC<{ group: AppCatalogGroup; href: (sel: string) => string }> = ({ group, href }) => (
  <>
    <div class="gh">
      <span>
        {group.title} · {group.count}
      </span>
      {group.note === "" ? null : <span class="gh-note">{group.note}</span>}
    </div>
    {group.state === null ? (
      group.rows.map((row) => (
        <div class="cr">
          <div>
            <a class="row-link mono" href={href(row.sel)}>
              {row.name}
            </a>
            {/* The app's own Markdown, inline only: a row is one line high (markdown.ts). */}
            <div class="cr-detail md">{raw(inlineMarkdown(row.description))}</div>
          </div>
          <div class="cr-control">
            <Badges badges={row.reach} empty="no agent" />
          </div>
        </div>
      ))
    ) : (
      <p class="note gh-state">{group.state}</p>
    )}
  </>
);

/** One row of the Arguments or Result card, in whichever of its two shapes it came in —
 *  a tool's schema leaf, or a prompt's declared argument (§20.3: a prompt has no schema). */
const ArgRow: FC<{ row: AppSchemaRow }> = ({ row }) =>
  row.kind === "leaf" ? (
    <div class="arg">
      <div class="mono">{row.path}</div>
      <div class="muted">{row.type}</div>
      <div>{row.writeOnly ? <span class="badge badge--warning">writeOnly · masked</span> : null}</div>
    </div>
  ) : (
    <div class="arg">
      <div class="mono">{row.path}</div>
      <div class="muted md">
        {row.description === "" ? "—" : raw(inlineMarkdown(row.description))}
      </div>
      <div class="muted">{row.required ? "required" : "optional"}</div>
    </div>
  );

const ArgCard: FC<{ title: string; rows: AppSchemaRow[] }> = ({ title, rows }) => (
  <section class="card card--pad">
    <div class="eyebrow">{title}</div>
    {rows.length === 0 ? <p class="note">none</p> : rows.map((row) => <ArgRow row={row} />)}
  </section>
);

const CatalogDetailsView: FC<{ view: AppCatalogDetails; slug: string }> = ({ view, slug }) => {
  if (view.kind === "none") {
    return (
      <div class="details">
        <div class="dh">
          <div class="listing-title">Catalog</div>
          <p class="note">Select a tool, prompt or resource for its details.</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">Where this comes from</div>
            <div class="kv">
              <Kv k="Schemas">{view.schemas}</Kv>
              <Kv k="Reach">computed with the gate's own matcher over each agent's grant</Kv>
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
          <span class="listing-title mono">{view.name}</span>
          <span class="badge badge--muted">{view.family}</span>
        </div>
        {view.description === "" ? null : <div class="note md">{raw(renderMarkdown(view.description))}</div>}
      </div>
      <div class="db">
        {view.resource === null ? null : (
          <section class="card card--pad">
            <div class="eyebrow">Resource</div>
            <div class="kv">
              <Kv k="URI">
                <span class="mono">{view.resource.uri}</span>
              </Kv>
              <Kv k="Type">{view.resource.type === "" ? "—" : view.resource.type}</Kv>
              <Kv k="Served on">
                <span class="mono">{view.resource.servedOn}</span>
              </Kv>
              <Kv k="Matched">by URI, never by name</Kv>
            </div>
          </section>
        )}
        {view.args === null ? null : <ArgCard title="Arguments" rows={view.args} />}
        {view.results === null ? null : <ArgCard title="Result · outputSchema" rows={view.results} />}
        <section class="card card--pad">
          <div class="eyebrow">What only the hub knows</div>
          <div class="kv">
            {view.calledAs === null ? null : (
              <Kv k="Called as">
                <span class="mono">{view.calledAs}</span>
              </Kv>
            )}
            <Kv k="Reachable by">
              {view.reachableBy.length === 0
                ? "no agent yet"
                : view.reachableBy.map((line) => <div>{line}</div>)}
            </Kv>
            {view.approval === null ? null : <Kv k="Approval">{view.approval}</Kv>}
            {view.redaction === null ? null : <Kv k="Redaction">{view.redaction}</Kv>}
          </div>
        </section>
        <p class="note">
          The same block the audit row and the agent page show for this {view.family}. Editing reach happens on{" "}
          <a href={paths.appPane(slug, "access")}>Agents</a>, masking on{" "}
          <a href={paths.appPane(slug, "recording")}>Recording</a>.
        </p>
      </div>
    </div>
  );
};

const CatalogPane: FC<{ props: AppDetailProps; pane: AppPaneView & { kind: "catalog" } }> = ({ props, pane }) => {
  const slug = props.header.slug;
  const base = paths.appDetail(slug);
  const href = (sel: string): string =>
    `${base}?${new URLSearchParams(pane.q === "" ? { sel } : { q: pane.q, sel })}`;
  return (
    <>
      {/* `--landing`: below the breakpoint this listing shows at level 1 beside the rail,
          because the Catalog has no second URL to be level 2 at (model's `appLevel`). */}
      <div class="listing listing--landing">
        <div class="lh">
          <div class="title-row">
            <span class="listing-title">Catalog</span>
            <span class="note">{pane.subtitle}</span>
          </div>
          <div class="sum">{pane.summary}</div>
          <form method="get" action={base} class="lh-filter">
            <input
              type="search"
              name="q"
              value={pane.q}
              placeholder="filter tools, prompts, resources…"
              aria-label="Filter"
            />
          </form>
        </div>
        <div class="scroll">
          {pane.state === null ? (
            pane.groups.map((group) => <CatalogGroupView group={group} href={href} />)
          ) : (
            <div class="empty empty--inline">
              <div class="empty-text">{pane.state.text}</div>
              {pane.state.reconnect && props.header.connect !== null ? (
                <form method="post" action={props.header.connect.href}>
                  <input type="hidden" name="csrf" value={props.csrfToken} />
                  <button type="submit" class="btn btn--outline btn--sm">
                    {props.header.connect.label}
                  </button>
                </form>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <CatalogDetailsView view={pane.details} slug={slug} />
    </>
  );
};

/* ---------------------------------------------------------------- Roles --- */

/** The small source badge: `built-in` / `app` / `app · replaced yours` / `yours`. */
const SourceBadge: FC<{ row: Pick<AppRoleRow, "source" | "sourceTitle"> }> = ({ row }) => (
  <span
    class={row.source === "yours" ? "badge badge--success badge--xs" : "badge badge--xs"}
    title={row.sourceTitle ?? undefined}
  >
    {row.source}
  </span>
);

const RoleDetailsView: FC<{ props: AppDetailProps; view: AppRoleDetails }> = ({ props, view }) => {
  const slug = props.header.slug;
  const base = paths.appPane(slug, "roles");
  if (view.kind === "none") {
    return (
      <div class="details">
        <div class="dh">
          <div class="listing-title">Roles</div>
          <p class="note">Select a role to see what it can do, or add one of your own.</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">Two sources, one rule</div>
            <div class="kv">
              <Kv k="The app's">{view.appsOwn}</Kv>
              <Kv k="Yours">defined here by ticking items or adding patterns; usable in grants like any role</Kv>
              <Kv k="Collision">
                if the app later declares a name you defined, its declaration replaces yours — the row says so
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
          {view.isNew ? (
            // Outside the form below it, and bound to it by `form=`: the filter under this
            // header is a GET form of its own, so the two cannot nest.
            <input
              class="input input--mono input--auto"
              type="text"
              name="role"
              form={ROLE_FORM}
              value={view.name}
              placeholder="role name"
              pattern="[a-z0-9_-]+"
              aria-label="Role name"
            />
          ) : (
            <span class="listing-title mono">{view.name}</span>
          )}
          <span class={view.source === "yours" ? "badge badge--success" : "badge badge--muted"}>{view.badge}</span>
          <span class="title-row-end">
            <Badges badges={view.holders} empty={view.isNew ? "" : "held by no agent"} />
          </span>
        </div>
        <p class="note">{view.explain}</p>
        {view.editable ? (
          <form method="get" action={base} class="lh-filter">
            {view.isNew ? <input type="hidden" name="new" value="1" /> : <input type="hidden" name="sel" value={`role:${view.name}`} />}
            <input type="search" name="q" value={view.q} placeholder="filter, or type a pattern…" aria-label="Filter" />
          </form>
        ) : null}
      </div>
      <Refusal error={view.error} />
      <form id={ROLE_FORM} method="post" action={paths.appRoleSet(slug)} class="listing-form">
        <input type="hidden" name="csrf" value={props.csrfToken} />
        {/* The role being edited (empty for a new one) and, for a saved role, its name —
            the new-role name rides the input above through `form=`. */}
        <input type="hidden" name="was" value={view.isNew ? "" : view.name} />
        {view.isNew ? null : <input type="hidden" name="role" value={view.name} />}
        <div class="scroll">
          {view.groups.map((group) => (
            <>
              <div class="gh sticky">
                <span>
                  {group.title} · {group.count}
                </span>
              </div>
              {group.state === null ? (
                group.rows.map((row) => (
                  <div class="cr">
                    <div>
                      <span class="mono">{row.name}</span>
                      <div class="cr-detail">
                        <span class="md">{raw(inlineMarkdown(row.description))}</span>
                        {row.via.length === 0 ? null : (
                          <>
                            {" "}
                            · via <span class="mono">{row.via.join(", ")}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div class="cr-control">
                      {row.locked ? (
                        <span class="cb lock" title={row.lockTitle}>
                          <Check />
                        </span>
                      ) : row.field === "" ? (
                        <span class="cb" title={row.lockTitle} aria-hidden="true"></span>
                      ) : (
                        <input class="cb" type="checkbox" name={row.field} value="1" checked={row.checked} aria-label={row.name} />
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p class="note gh-state">{group.state}</p>
              )}
            </>
          ))}
          {view.patterns.length === 0 && view.offer === null ? null : (
            <>
              <div class="gh sticky">
                <span>Patterns · {view.patterns.length}</span>
                <span class="gh-note">anchored · * aliases .*</span>
              </div>
              {view.patterns.map((row) => (
                <div class="cr">
                  <div>
                    <span class="mono">{row.pattern}</span> <span class="ty">{row.family}</span>
                    <div class="cr-detail">{row.detail}</div>
                  </div>
                  <div class="cr-control">
                    {row.editable ? (
                      <button type="submit" class="cb on" name="drop" value={row.entry} title="remove this pattern">
                        <Check />
                      </button>
                    ) : (
                      <span class="cb lock" title="in this role">
                        <Check />
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {view.offer === null ? null : (
                <div class="cr">
                  <div>
                    <span class="mono">{view.offer.pattern}</span> <span class="ty">{view.offer.family}</span>
                    <div class="cr-detail">{view.offer.detail}</div>
                  </div>
                  <div class="cr-control">
                    <button type="submit" class="btn btn--outline btn--sm" name="add" value={view.offer.pattern}>
                      Add as pattern
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {/* A pattern this render still LISTS survives the save: the checkboxes name
            literals only, so without these the composer would read a pattern row the owner
            never touched as one they removed (§4). */}
        {view.keep.map((entry) => (
          <input type="hidden" name="keep" value={entry} />
        ))}
        {view.editable ? (
          <div class="save">
            {view.isNew ? (
              <span class="muted">nothing saved yet</span>
            ) : (
              <span class="save-end">
                <button type="submit" class="btn btn--danger-outline btn--sm" name="delete" value="1">
                  Delete role
                </button>
                <span class="muted">grants naming it keep the name and match nothing until it exists again</span>
              </span>
            )}
            <span class="save-end">
              <a class="btn btn--ghost btn--sm" href={base}>
                Discard
              </a>
              <button type="submit" class="btn btn--primary btn--sm">
                Save
              </button>
            </span>
          </div>
        ) : null}
      </form>
    </div>
  );
};

const RolesPane: FC<{ props: AppDetailProps; pane: AppPaneView & { kind: "roles" } }> = ({ props, pane }) => {
  const slug = props.header.slug;
  const base = paths.appPane(slug, "roles");
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row">
            <span class="listing-title">Roles</span>
            <span class="note">named sets of what this app exposes</span>
          </div>
          <div class="sum">{pane.summary}</div>
        </div>
        <div class="scroll">
          {pane.rows.map((row) => (
            <div class="cr">
              <div>
                <a class="row-link mono" href={`${base}?sel=${row.sel}`}>
                  {row.name}
                </a>{" "}
                <SourceBadge row={row} />
                <div class="cr-detail">{row.detail}</div>
              </div>
              <div class="cr-control">
                <Badges badges={row.holders} empty="held by no agent" />
              </div>
            </div>
          ))}
        </div>
        <div class="save">
          <a class="btn btn--outline btn--sm" href={`${base}?new=1`}>
            New role
          </a>
        </div>
      </div>
      <RoleDetailsView props={props} view={pane.details} />
    </>
  );
};

/* ------------------------------------------------------------ Recording --- */

const RecordingSectionView: FC<{ section: AppRecordingSection }> = ({ section }) => (
  <>
    <div class="gh sticky">
      <span>
        {section.title} · {section.count} path{section.count === 1 ? "" : "s"}
      </span>
      <span class="gh-note">{section.note}</span>
    </div>
    {section.state === null ? (
      section.rows.map((row) => (
        <>
          <div class="cr">
            <div>
              <span class="mono">{row.path}</span> <span class="ty">{row.type}</span>
              <div class="cr-detail">
                {row.detail}
                {row.which === null ? null : (
                  <>
                    {" "}
                    <a href={row.which.href}>{row.which.label}</a>
                  </>
                )}
              </div>
            </div>
            <div class="cr-control">
              {row.control.kind === "locked" ? (
                <span class="cb lock" title="declared writeOnly by the app — always masked">
                  <Check />
                </span>
              ) : row.control.kind === "mixed" ? (
                <span class="cb mixed" title="masked on some of its tools — set it per tool below">
                  <Dash />
                </span>
              ) : (
                <input
                  class="cb"
                  type="checkbox"
                  name={row.control.field}
                  value="1"
                  checked={row.control.checked}
                  aria-label={`mask ${row.path}`}
                  title="mask on every tool that takes it"
                />
              )}
            </div>
          </div>
          {row.tools.map((tool) => (
            <div class="cr cr--sub">
              <div>
                <span class="mono">{tool.tool}</span>
                {tool.writeOnly ? <div class="cr-detail">declared by the app — always masked</div> : null}
              </div>
              <div class="cr-control">
                {tool.writeOnly ? (
                  <span class="cb lock">
                    <Check />
                  </span>
                ) : (
                  <input
                    class="cb"
                    type="checkbox"
                    name={tool.field}
                    value="1"
                    checked={tool.checked}
                    aria-label={`mask ${row.path} on ${tool.tool}`}
                  />
                )}
              </div>
            </div>
          ))}
        </>
      ))
    ) : (
      <p class="note gh-state">{section.state}</p>
    )}
    {section.noSchema === null ? null : <p class="note gh-state">{section.noSchema}</p>}
  </>
);

const MaskedCard: FC<{ card: AppRecordingCard }> = ({ card }) => (
  <section class="card card--pad">
    <div class="eyebrow">{card.title}</div>
    {card.rows.length === 0 ? (
      <p class="note">{card.empty}</p>
    ) : (
      card.rows.map((row) => (
        <div class="kv-row">
          <div class="mono">{row.path}</div>
          <div class="muted">{row.detail}</div>
        </div>
      ))
    )}
  </section>
);

const RecordingPane: FC<{ props: AppDetailProps; pane: AppPaneView & { kind: "recording" } }> = ({ props, pane }) => {
  const slug = props.header.slug;
  const base = paths.appPane(slug, "recording");
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row title-row--split">
            <span class="listing-title">Recording</span>
            <span class="note">what the audit trail keeps, and what it masks</span>
            {/* A real checkbox styled as the switch, bound to the form below by `form=`:
                the label is visible text, so the state is readable without the colour. */}
            <label class="sw-label title-row-end">
              <span>Record call bodies</span>
              <input class="sw" type="checkbox" name="log" value="1" checked={pane.log} form={RECORDING_FORM} />
            </label>
          </div>
          <div class="sum">{pane.summary}</div>
          <form method="get" action={base} class="lh-filter">
            <input type="search" name="q" value={pane.q} placeholder="filter paths…" aria-label="Filter" />
          </form>
        </div>
        {pane.warning === null ? null : (
          <div class="alert alert--warning" role="status">
            <div class="alert-text">{pane.warning}</div>
          </div>
        )}
        <Refusal error={pane.error} />
        <form id={RECORDING_FORM} method="post" action={paths.appRecordingSet(slug)} class="listing-form">
          <input type="hidden" name="csrf" value={props.csrfToken} />
          <div class="scroll">
            {pane.sections.map((section) => (
              <RecordingSectionView section={section} />
            ))}
          </div>
          {/* Every stored entry these rows do not represent, so a save never drops one. */}
          {pane.keep.map((field) => (
            <input type="hidden" name={field.field} value={field.value} />
          ))}
          <div class="save">
            <a href={pane.auditHref}>Recorded calls to {slug} →</a>
            <span class="save-end">
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
      <div class="details">
        <div class="dh">
          <div class="listing-title">Masked before recording</div>
          <p class="note">{pane.intro}</p>
        </div>
        <div class="db">
          {pane.cards.map((card) => (
            <MaskedCard card={card} />
          ))}
          <section class="card card--pad">
            <div class="eyebrow">What a recorded call keeps</div>
            <div class="kv">
              <Kv k="Arguments">
                <span class="mono">params.arguments</span>, post-redaction
              </Kv>
              <Kv k="Results">
                <span class="mono">structuredContent</span> post-redaction; text, image and resource blocks become
                size stubs, never bytes
              </Kv>
              <Kv k="Cap">
                16 KiB per body — an over-cap body is one <span class="mono">oversize</span> stub
              </Kv>
              <Kv k="Kept for">
                7 days, then pruned with the rest of the audit table ·{" "}
                <a href={paths.auditExport({ app: slug })}>Export JSONL</a> to keep longer
              </Kv>
              <Kv k="Never">
                refused calls, token material, <span class="mono">writeOnly</span> and config-masked fields
              </Kv>
            </div>
          </section>
          <p class="note">
            A tick writes one literal (tool, path) entry per tool; nothing here is a pattern and nothing is typed.
            Masking applies to the approval record too.
          </p>
        </div>
      </div>
    </>
  );
};

/* ------------------------------------------------------------- Overview --- */

const OverviewPane: FC<{ pane: AppPaneView & { kind: "overview" } }> = ({ pane }) => (
  <div class="listing listing--wide">
    <div class="lh">
      <span class="listing-title">Overview</span>
    </div>
    <div class="scroll">
      <div class="kv kv--pad">
        {pane.rows.map((row) => (
          <div class="kv-row">
            <div class="kv-key">{row.key}</div>
            <div class={row.mono ? "mono" : undefined}>{row.value}</div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* --------------------------------------------------------------- Agents --- */

const AccessDetailsView: FC<{ props: AppDetailProps; view: AppAccessDetails }> = ({ props, view }) => {
  const slug = props.header.slug;
  if (view.kind === "none") {
    return (
      <div class="details">
        <div class="dh">
          <div class="listing-title">Agents</div>
          <p class="note">Select an agent to edit what it may call on {slug}.</p>
        </div>
        <div class="db">
          <section class="card card--pad">
            <div class="eyebrow">Per tool</div>
            <div class="kv">
              {view.perTool.map((row) => (
                <Kv k={row.name}>{row.agents}</Kv>
              ))}
            </div>
            {view.more === 0 ? null : <p class="note">… {view.more} more in the Catalog</p>}
          </section>
        </div>
      </div>
    );
  }
  // A grant row's `?sel=` belongs to the AGENT page, whose details pane explains a role,
  // a pattern or an item; here `sel` already names the agent being edited, so the rows
  // link where the explanation actually lives.
  const href = (sel: string): string => `${view.agentHref}?${new URLSearchParams({ sel })}`;
  return (
    <div class="details">
      <div class="dh">
        <div class="title-row">
          <span class="listing-title mono">{view.slug}</span>
          <span class="badge badge--muted">agent</span>
          {view.description === "" ? null : <span class="note">{view.description}</span>}
          {view.newGrant ? <span class="badge badge--warning badge--dashed">new grant · nothing saved yet</span> : null}
          <a class="title-row-end" href={view.agentHref}>
            open agent page
          </a>
        </div>
        <p class="note">
          {view.slug}'s grant on {slug}. Solid: set on the row · hollow: implied by a role · a row cannot lower what
          a role grants.
        </p>
        <div class="sum">{reachLine(view.slug, view.reach)}</div>
      </div>
      <Refusal error={view.error} />
      <form method="post" action={paths.appGrantSet(slug)} class="listing-form">
        <input type="hidden" name="csrf" value={props.csrfToken} />
        <input type="hidden" name="agent" value={view.slug} />
        <div class="scroll">
          {view.groups.map((group) => (
            <GrantGroup group={group} href={href} />
          ))}
        </div>
        {/* What this render drew no control for still belongs to the set, and Save replaces
            the set whole — so it rides along as a hidden field. */}
        {view.carry.map((field) => (
          <input type="hidden" name={field.field} value={field.value} />
        ))}
        <div class="save">
          <a
            class="btn btn--danger-outline btn--sm"
            href={paths.appConfirmAgent(slug, "remove-agent", view.slug)}
          >
            Remove {view.slug}
          </a>
          <span class="save-end">
            <a class="btn btn--ghost btn--sm" href={paths.appPane(slug, "access")}>
              Discard
            </a>
            <button type="submit" class="btn btn--primary btn--sm">
              Save
            </button>
          </span>
        </div>
      </form>
    </div>
  );
};

const AccessPane: FC<{ props: AppDetailProps; pane: AppPaneView & { kind: "access" } }> = ({ props, pane }) => {
  const slug = props.header.slug;
  const base = paths.appPane(slug, "access");
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row">
            <span class="listing-title">Agents</span>
            <span class="note">who can call this app, and how</span>
          </div>
          <div class="sum">{pane.summary}</div>
        </div>
        <div class="scroll">
          {pane.rows.map((row) => (
            <div class="cr">
              <div>
                <a class="row-link mono" href={`${base}?sel=${row.sel}`}>
                  {row.slug}
                </a>{" "}
                <span class="note">{row.description}</span>
                <div class="cr-detail">
                  <div>
                    <span class="muted">allowed</span>{" "}
                    {row.allowed.length === 0 ? (
                      <span class="muted">—</span>
                    ) : (
                      row.allowed.map((entry) => <span class="badge badge--mono">{entry}</span>)
                    )}
                  </div>
                  <div>
                    <span class="muted">ask first</span>{" "}
                    {row.askFirst.length === 0 ? (
                      <span class="muted">—</span>
                    ) : (
                      row.askFirst.map((entry) => <span class="badge badge--warning">{entry}</span>)
                    )}
                  </div>
                  <div>{row.reach}</div>
                </div>
              </div>
              <div class="cr-control"></div>
            </div>
          ))}
          <p class="note gh-state">
            Granting a new agent starts from the agent's own page — <a href={paths.agents}>Agents</a> → the agent →
            Grant another app.
          </p>
        </div>
      </div>
      <AccessDetailsView props={props} view={pane.details} />
    </>
  );
};

/* ---------------------------------------------------------------- Token --- */

const TokenPane: FC<{ props: AppDetailProps; pane: AppPaneView & { kind: "token" } }> = ({ props, pane }) => {
  const slug = props.header.slug;
  const base = paths.appPane(slug, "token");
  if (pane.proxied) {
    return (
      <div class="listing listing--wide">
        <div class="lh">
          <span class="listing-title">Token</span>
        </div>
        <div class="scroll">
          <p class="note gh-state">
            Proxied apps hold no tokens — the hub dials the upstream; nothing dials in.
          </p>
        </div>
      </div>
    );
  }
  const isNew = (row: AppTokenRow): boolean =>
    pane.details.kind === "token" && pane.details.isNew && pane.details.row.id === row.id;
  return (
    <>
      <div class="listing">
        <div class="lh">
          <div class="title-row title-row--split">
            <span class="listing-title">Token</span>
            <span class="note">what the app presents to dial in</span>
            {/* The one mutation on this page that answers 200 rather than the redirect-back:
                a plaintext key must never ride a URL (§15), so its own route re-renders this
                pane with the reveal in place. */}
            <form
              method="post"
              action={paths.appOp(slug, "token_issue", { kind: "app", slug })}
              class="title-row-end"
            >
              <input type="hidden" name="csrf" value={props.csrfToken} />
              <button type="submit" class="btn btn--outline btn--sm">
                Issue new token
              </button>
            </form>
          </div>
          <div class="sum">{pane.summary}</div>
        </div>
        <div class="scroll">
          {pane.rows.length === 0 ? (
            <p class="note gh-state">No live token — the app cannot connect until one is issued.</p>
          ) : (
            pane.rows.map((row) => (
              <div class="cr">
                <div>
                  <a class="row-link mono" href={`${base}?sel=token:${row.id}`}>
                    {row.prefix}
                  </a>
                  {row.live ? <> <span class="badge badge--success">holds the live socket</span></> : null}
                  {isNew(row) ? <> <span class="badge badge--success badge--dashed">new</span></> : null}
                  <div class="cr-detail">
                    issued {formatLastSeen(row.createdAt, props.now)} ·{" "}
                    {row.lastUsedAt === null ? "never used" : `used ${formatLastSeen(row.lastUsedAt, props.now)}`}
                  </div>
                </div>
                <div class="cr-control">
                  <a
                    class="btn btn--danger-outline btn--sm"
                    href={paths.appConfirm(slug, "token", "revoke-token", row.id)}
                  >
                    Revoke
                  </a>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
      <div class="details">
        {pane.details.kind === "none" ? (
          <div class="dh">
            <div class="listing-title">Token</div>
            <p class="note">Select a token for its details.</p>
          </div>
        ) : (
          <>
            <div class="dh">
              <div class="title-row">
                <span class="listing-title mono">{pane.details.row.prefix}</span>
                <span class="badge badge--muted">app token</span>
              </div>
              <p class="note">Only valid for opening the reverse WebSocket as {slug}.</p>
            </div>
            <div class="db">
              {props.reveal === null || !pane.details.isNew ? null : (
                <section class="card card--pad">
                  <div class="eyebrow">Shown once — copy it now</div>
                  <TokenReveal token={props.reveal}>
                    <p class="note">The previous token keeps working until you revoke it.</p>
                  </TokenReveal>
                </section>
              )}
              <section class="card card--pad">
                <div class="kv">
                  <Kv k="Issued">{formatStamp(pane.details.row.createdAt)}</Kv>
                  <Kv k="Expires">never — revoke on compromise</Kv>
                  <Kv k="Last used">
                    {pane.details.row.lastUsedAt === null
                      ? "never"
                      : formatLastSeen(pane.details.row.lastUsedAt, props.now)}
                  </Kv>
                  <Kv k="Connection">{pane.details.row.live ? "holds the live socket now" : "none"}</Kv>
                </div>
              </section>
            </div>
          </>
        )}
      </div>
    </>
  );
};

/* ----------------------------------------------------------- Danger zone --- */

const DangerPane: FC<{ props: AppDetailProps; pane: AppPaneView & { kind: "danger" } }> = ({ props, pane }) => {
  const slug = props.header.slug;
  return (
    <div class="listing listing--wide">
      <div class="lh">
        <span class="listing-title">Danger zone</span>
      </div>
      <div class="scroll">
        <div class="db">
          <section class="card card--pad">
            <h2 class="card-title">{pane.archived ? "Unarchive" : `Archive ${slug}`}</h2>
            <p class="card-desc">
              {pane.archived
                ? "It accepts connections again, with everything it kept while archived."
                : "It refuses connections and leaves the list — tokens, grants and history are kept."}
            </p>
            <div class="actions actions--start">
              {pane.archived ? (
                <form method="post" action={paths.appOp(slug, "app_unarchive", { slug })}>
                  <input type="hidden" name="csrf" value={props.csrfToken} />
                  <button type="submit" class="btn btn--outline btn--sm">
                    Unarchive
                  </button>
                </form>
              ) : (
                <a class="btn btn--outline btn--sm" href={paths.appConfirm(slug, "danger", "archive")}>
                  Archive {slug}
                </a>
              )}
            </div>
          </section>
          <section class="card card--pad card--danger">
            <h2 class="card-title">Delete {slug}</h2>
            <p class="card-desc">
              Revokes its {pane.tokens} token{pane.tokens === 1 ? "" : "s"}, closes the live connection and removes
              every grant ({pane.agents} agent{pane.agents === 1 ? "" : "s"}). This cannot be undone.
            </p>
            <div class="actions actions--start">
              <a class="btn btn--danger-outline btn--sm" href={paths.appConfirm(slug, "danger", "delete")}>
                Delete {slug}
              </a>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

/* ---------------------------------------------------------------- dialogs --- */

/**
 * The four destructive confirmations `/apps/<slug>` raises, as server-rendered
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
  const spec =
    confirm.kind === "revoke-token"
      ? {
          title: `Revoke “${confirm.prefix}”?`,
          text: confirm.live
            ? "Revoking closes the app's live connection."
            : "The app can no longer connect with it.",
          action: paths.appOp(slug, "token_revoke", { id: confirm.id }),
          word: "Revoke",
        }
      : confirm.kind === "remove-agent"
        ? {
            title: `Remove ${confirm.agent} from ${slug}?`,
            text: `${confirm.agent} loses every entry on ${slug}. History stays; a waiting request expires.`,
            action: paths.appGrantSet(slug),
            word: "Remove",
          }
        : confirm.kind === "archive"
          ? {
              title: `Archive “${slug}”?`,
              text: "It refuses connections and leaves the list — tokens, grants and history are kept.",
              action: paths.appOp(slug, "app_archive", { slug }),
              word: "Archive",
            }
          : {
              title: `Delete “${slug}”?`,
              text: "Revokes its tokens, closes the live connection and removes every grant. This cannot be undone.",
              action: paths.appOp(slug, "app_delete", { slug }),
              word: "Delete",
            };
  return (
    <ConfirmShell id={DIALOG_ID} title={spec.title} text={spec.text}>
      <form method="post" action={spec.action} class="actions">
        <input type="hidden" name="csrf" value={csrfToken} />
        {/* The whole set, cleared: `grant_set` replaces it, so an empty one IS the removal
            — the same op Save posts, with nothing to compose. */}
        {confirm.kind === "remove-agent" ? (
          <>
            <input type="hidden" name="agent" value={confirm.agent} />
            <input type="hidden" name="clear" value="1" />
          </>
        ) : null}
        <a class="btn btn--ghost" href={pane}>
          Cancel
        </a>
        <button type="submit" class="btn btn--danger">
          {spec.word}
        </button>
      </form>
    </ConfirmShell>
  );
};

/* ------------------------------------------------------------- the panes --- */

const Pane: FC<{ props: AppDetailProps }> = ({ props }) => {
  const pane = props.pane;
  if (pane.kind === "catalog") return <CatalogPane props={props} pane={pane} />;
  if (pane.kind === "roles") return <RolesPane props={props} pane={pane} />;
  if (pane.kind === "recording") return <RecordingPane props={props} pane={pane} />;
  if (pane.kind === "overview") return <OverviewPane pane={pane} />;
  if (pane.kind === "access") return <AccessPane props={props} pane={pane} />;
  if (pane.kind === "token") return <TokenPane props={props} pane={pane} />;
  return <DangerPane props={props} pane={pane} />;
};

/* ------------------------------------------------------------------ page --- */

export const AppDetailPage: FC<AppDetailProps> = (props) => {
  const entries = paneEntries(props);
  const header = props.header;
  return (
    <Layout
      title={`${header.name} · Apps · personal-mcps`}
      active={props.section}
      username={props.username}
      pendingApprovals={props.pendingApprovals}
    >
      {/* `data-level` is read by the narrow stylesheet ALONE: it shows one of the rail, the
          listing and the details by it, and the wide one never looks. */}
      <main class="page--workspace" data-level={String(props.level)}>
        <LevelHeader header={props.levelHeader} />

        <div class="page-head">
          <div>
            {/* ONE row: where the page sits, what it is, and what it is called. */}
            <div class="title-row">
              <a class="crumb" href={paths.apps}>
                Apps
              </a>
              <span class="crumb-sep" aria-hidden="true">
                ›
              </span>
              <h1 class="page-title">{header.name}</h1>
              <div class="badge-row">
                <span class="badge badge--title badge--mono">{header.slug}</span>
                <span class="badge badge--title badge--mono">{header.kind}</span>
                {header.status === null ? null : (
                  <span class={`${STATUS_CLASS[header.status] ?? "badge badge--muted"} badge--title`}>
                    {header.status}
                  </span>
                )}
              </div>
            </div>
            {header.description === "" ? null : <p class="page-subtitle">{header.description}</p>}
          </div>
          {/* ONE line, the parts separated by the hub's own middot — five tiles side by side
              would read as five independent facts rather than one partition. */}
          <div class="tiles">{header.tiles}</div>
        </div>

        {/* §13's archived banner, on every pane rather than on the danger zone alone: an
            archived app's page stays reachable and everything on it is still listed, so the
            one thing a reader needs on any of them is why nothing connects. */}
        {header.archived ? (
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

        {/* The proxied header card sits ABOVE the framed box on every pane except Overview,
            which prints those same three facts as its own first rows (§2). */}
        {header.kind === "proxy" ? (
          <UpstreamCard header={header} csrfToken={props.csrfToken} rows={props.pane.kind !== "overview"} />
        ) : null}

        {/* `--framed`: the rail and the panes are ONE box here as they are on the agent
            page, so the paned pages read as one family. */}
        <div class="paned paned--framed">
          <PaneRail label={RAIL_NAV_LABEL} groups={paneGroups(entries)} />
          <div class="pane pane--split">
            <Pane props={props} />
          </div>
        </div>
      </main>
      {props.confirm === null ? null : (
        <AppConfirmDialog confirm={props.confirm} slug={header.slug} csrfToken={props.csrfToken} />
      )}
    </Layout>
  );
};
