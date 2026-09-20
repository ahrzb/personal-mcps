/**
 * The app pane's details column: the role, pattern or catalog member `?sel=` named, or the
 * pair's own summary.
 *
 * A port of `pages/agent-detail.tsx`'s `Details` and `model.ts`'s `detailsView` (`:3390`),
 * `catalogIdentity` and `reachableBy`.
 *
 * It carries NO control. An entry has exactly one three-way control on the page — its listing
 * row's — because two controls over one entry would be two answers to what the set holds.
 *
 * A selection naming nothing the listing drew falls back to the unselected view rather than
 * to a not-found: `sel` is a pointer INTO a live catalog, and an endpoint can disappear
 * between two renders.
 */

import type { ReactNode } from "react";
import { useAppEnv } from "@/lib/api-context";
import { BUILTIN_ROLE } from "@/lib/paths";
import { Copyable } from "@/chrome/Reveal";
import type {
  AliasDiagnostic,
  AppKind,
  AppRow,
  CatalogDerivation,
  ListedAgent,
  ListedItem,
  RoleDeclaration,
  RoleFamily,
} from "@/lib/types";
import { effectiveRolesOf, itemEntry, reachabilityFor, redactPathsIn, ROLE_FAMILIES } from "./door";
import { FAMILY_OF_KIND, familyCount, familyEntries, subjectOf } from "./grant-editor";
import type { GrantEditor, GrantFamilyView } from "./grant-editor";
import { Kv } from "./panes/Kv";

export function AppGrantDetails({
  agent,
  agents,
  row,
  kind,
  app,
  editor,
  views,
  diagnostics,
  sel,
}: {
  /** The agent whose set is being edited — every card in this column is "for" it. */
  agent: string;
  /** Every agent in the namespace, for the "Reachable by" line. */
  agents: ListedAgent[];
  row: AppRow;
  /** The registry's addressing kind, which is what the badge and the role card's provenance
   *  sentence read. */
  kind: AppKind;
  app: string;
  editor: GrantEditor;
  views: Record<RoleFamily, GrantFamilyView>;
  /** §23.6's sentences, rendered by the server and each carrying its own subject — the card
   *  prints only the ones about the selected member. */
  diagnostics: AliasDiagnostic[];
  /** `?sel=<kind>:<name>`, or "". */
  sel: string;
}): ReactNode {
  const declared = effectiveRolesOf(row);
  const modeOf = new Map(editor.entries.map((entry) => [entry.entry, entry.mode]));
  const at = sel.indexOf(":");
  const selKind = at < 0 ? "" : sel.slice(0, at);
  const name = at < 0 ? "" : sel.slice(at + 1);

  if (selKind === "role" && (name === BUILTIN_ROLE || name in declared)) {
    const builtin = name === BUILTIN_ROLE;
    const matched = editor.matchedNames.get(name) ?? { tools: [], prompts: [], resources: [] };
    const standing = modeOf.get(name);
    return (
      <div className="details">
        <div className="dh">
          <div className="title-row">
            <span className="listing-title mono">{name}</span>
            <span className="badge badge--muted">role</span>
          </div>
          <p className="note">
            {builtin
              ? "Built in: every family, present and future."
              : `Declared by ${row.name} ${kind === "tunnel" ? "at connect" : "in config"}.`}
          </p>
        </div>
        <div className="db">
          <section className="card card--pad">
            <div className="eyebrow">For {agent}</div>
            <div className="kv">
              <Kv k="Standing">
                {standing === "allow" ? "in Allowed" : standing === "approval" ? "in Ask first" : "not granted"}
              </Kv>
            </div>
          </section>
          <section className="card card--pad">
            <div className="eyebrow">Patterns</div>
            <div className="kv">
              {(builtin
                ? ROLE_FAMILIES.map((family): [string, string[]] => [family, [".*"]])
                : familyEntries(declared[name])
              ).map(([family, patterns]) => (
                <Kv k={family} key={family}>
                  <span className="mono">{patterns.join(", ")}</span>
                </Kv>
              ))}
            </div>
          </section>
          <section className="card card--pad">
            <div className="eyebrow">Matches today</div>
            <div className="kv">
              {ROLE_FAMILIES.map((family) => (
                <Kv k={family} key={family}>
                  {matched[family].length === 0 ? "none" : matched[family].join(", ")}
                </Kv>
              ))}
            </div>
          </section>
          <p className="note">
            A role widens when the app widens it. To keep a single item regardless, add it directly from its row.
          </p>
        </div>
      </div>
    );
  }

  if (selKind === "pattern") {
    const entry = editor.entries.find((held) => held.entry === name);
    if (entry !== undefined) {
      const matched = editor.matchedNames.get(name) ?? { tools: [], prompts: [], resources: [] };
      const matches = [...matched.tools, ...matched.prompts, ...matched.resources];
      return (
        <div className="details">
          <div className="dh">
            <div className="title-row">
              <span className="listing-title mono">{name}</span>
              <span className="badge badge--muted">pattern</span>
            </div>
            <p className="note">An entry that is not one item: anchored, * aliases .*.</p>
          </div>
          <div className="db">
            <section className="card card--pad">
              <div className="eyebrow">For {agent}</div>
              <div className="kv">
                <Kv k="Standing">{entry.mode === "allow" ? "in Allowed" : "in Ask first"}</Kv>
              </div>
            </section>
            <section className="card card--pad">
              <div className="eyebrow">Matches today · {matches.length}</div>
              {matches.length === 0 ? (
                <p className="note">nothing — kept, dormant</p>
              ) : (
                matches.map((each) => (
                  <div className="mono" key={each}>
                    {each}
                  </div>
                ))
              )}
            </section>
          </div>
        </div>
      );
    }
  }

  const family = FAMILY_OF_KIND[selKind];
  const view = family === undefined ? undefined : views[family];
  const item =
    family === undefined || view === undefined || view.state !== "listed"
      ? undefined
      : view.items.find((each) => subjectOf(each, family) === name);
  if (family !== undefined && item !== undefined && view !== undefined && view.state === "listed") {
    const here = editor.standing.get(`${family}::${name}`) ?? { mode: null, hits: [] };
    const entry = itemEntry(family, name);
    const via = here.hits.filter((each) => each.agent !== entry).map((each) => each.agent);
    const source = via.length > 0 ? `via ${via.join(", ")}` : "direct";
    const derived = view.derived?.find((each) => each.subject === name);
    return (
      <div className="details">
        <div className="dh">
          <div className="title-row">
            <span className="listing-title mono">{name}</span>
            <span className="badge badge--muted">{selKind}</span>
          </div>
          {/* The app's own prose, WHOLE — this card has room for the structure a row does
              not: paragraphs, lists, fences. The markup is `pages/markdown.ts`'s
              `renderMarkdown` output, rendered on the wire because that module is the only
              thing allowed to produce it. A resource's line is its media type, which is not
              prose and is drawn as text. */}
          <DescriptionNote item={item} family={family} derived={derived} />
        </div>
        <div className="db">
          <section className="card card--pad">
            <div className="eyebrow">For {agent}</div>
            <div className="kv">
              <Kv k="Standing">
                {here.mode === null
                  ? "not reachable"
                  : here.mode === "allow"
                    ? `allowed · ${source}`
                    : `ask · ${source}`}
              </Kv>
              {/* §7's three postures, said as the sentence each earns: allow beats ask, so an
                  ask entry added under an allowing role would change nothing — which is worth
                  saying where the owner is about to add one. */}
              <Kv k="Approval">
                {here.mode === "approval"
                  ? "Asked — each call waits for you."
                  : here.mode === "allow"
                    ? via.length > 0
                      ? `Not asked — allow wins over any ask entry, so adding one here would not gate it while ${via.join(", ")} allows it.`
                      : "Not asked."
                    : "—"}
              </Kv>
            </div>
          </section>
          {family !== "tools" ? null : (
            <section className="card card--pad">
              <div className="eyebrow">Arguments</div>
              {derived === undefined || derived.arguments.length === 0 ? (
                <p className="note">none</p>
              ) : (
                <div className="kv">
                  {derived.arguments.map((argument) => (
                    <Kv k={argument.name} key={argument.name}>
                      {argument.type === "" ? "" : `${argument.type} · `}
                      {argument.required ? "required" : "optional"}
                    </Kv>
                  ))}
                </div>
              )}
            </section>
          )}
          <HubCard
            row={row}
            app={app}
            family={family}
            member={name}
            declared={declared}
            agents={agents}
            diagnostics={diagnostics}
          />
        </div>
      </div>
    );
  }

  const counts = {
    tools: familyCount(views.tools, editor.standing, "tools"),
    prompts: familyCount(views.prompts, editor.standing, "prompts"),
    resources: familyCount(views.resources, editor.standing, "resources"),
  };
  return (
    <div className="details">
      <div className="dh">
        <div className="title-row">
          <span className="listing-title">{row.name}</span>
          <span className="badge badge--mono">{kind}</span>
        </div>
        <p className="note">Select a role, tool, prompt or resource on the left for its details.</p>
      </div>
      <div className="db">
        <section className="card card--pad">
          <div className="eyebrow">Catalog</div>
          <div className="kv">
            <Kv k="Tools">
              {counts.tools.total} · {counts.tools.reached} reached by {agent}
            </Kv>
            <Kv k="Prompts">
              {counts.prompts.total} · {counts.prompts.reached} reached
            </Kv>
            <Kv k="Resources">
              {counts.resources.total} · {counts.resources.reached} reached
            </Kv>
            <Kv k="Roles">
              {Object.keys(declared).length === 0 ? "none declared" : Object.keys(declared).join(", ")}
            </Kv>
          </div>
        </section>
        <section className="card card--pad">
          <div className="eyebrow">Grant set for {agent}</div>
          <div className="kv">
            <Kv k="Allowed">
              {editor.entries.filter((entry) => entry.mode === "allow").length === 0
                ? "nothing"
                : editor.entries
                    .filter((entry) => entry.mode === "allow")
                    .map((entry) => entry.entry)
                    .join(", ")}
            </Kv>
            <Kv k="Ask first">
              {editor.entries.filter((entry) => entry.mode === "approval").length === 0
                ? "nothing"
                : editor.entries
                    .filter((entry) => entry.mode === "approval")
                    .map((entry) => entry.entry)
                    .join(", ")}
            </Kv>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * "What only the hub knows": the canonical scoped identity a member is served on, its
 * TypeScript identity where it has one, who the door lets through, and §7's mask.
 *
 * The scoped endpoint is built from the hub's CANONICAL origin and the signed-in username,
 * which is the same string `paths.mcpScoped` spells server-side. Deliberately not the
 * browser's own origin: this is a value the owner copies into a bot's configuration, so a
 * dashboard reached through a proxy or an alias host must still hand out the endpoint the
 * hub actually answers on.
 *
 * The TypeScript path is read off the COMMITTED reservations (`typescriptReservations`), never
 * off the owner's configuration: the committed map is what the runtime and the SDK see, and a
 * path exists only where both the service's and the member's reservations are active.
 */
function HubCard({
  row,
  app,
  family,
  member,
  declared,
  agents,
  diagnostics,
}: {
  row: AppRow;
  app: string;
  family: RoleFamily;
  member: string;
  declared: RoleDeclaration;
  agents: ListedAgent[];
  diagnostics: AliasDiagnostic[];
}): ReactNode {
  const { bootstrap } = useAppEnv();
  const endpoint = `${bootstrap.origin}/${encodeURIComponent(bootstrap.username)}/mcp/${encodeURIComponent(app)}`;
  const service = row.typescriptReservations.find(
    (reservation) => reservation.active && reservation.family === "service" && reservation.canonicalName === app,
  );
  const tool = row.typescriptReservations.find(
    (reservation) => reservation.active && reservation.family === "tool" && reservation.canonicalName === member,
  );
  const path = service === undefined || tool === undefined ? null : `mcp.${service.typescriptName}.${tool.typescriptName}`;
  const source =
    service === undefined || tool === undefined
      ? null
      : service.source === tool.source
        ? service.source
        : `service ${service.source} · tool ${tool.source}`;
  return (
    <section className="card card--pad">
      <div className="eyebrow">What only the hub knows</div>
      <div className="kv">
        <Kv k="Scoped MCP identity">
          <div>
            <span className="mono">{app}</span>
            {" / "}
            <span className="mono">{member}</span>
          </div>
          <Copyable value={endpoint} />
        </Kv>
        {family !== "tools" ? null : (
          <Kv k="TypeScript identity">
            <div>
              {path === null ? "unavailable" : <span className="mono">{path}</span>}
              {source === null ? null : ` · ${source}`}
            </div>
            {/* Only the sentences about THIS member and its service — each diagnostic names
                its own subject, so the card shows what belongs to the row it has selected and
                nothing about another member. The prose is §23.6's own
                (`hub-types.aliasDiagnosticMessage`), rendered server-side and never re-worded
                here. */}
            {diagnostics
              .filter(
                (entry) =>
                  (entry.family === "service" && entry.canonicalName === app) ||
                  (entry.family === "tool" && entry.canonicalName === member),
              )
              .map((entry) => (
                <div className="field-error" key={`${entry.family}/${entry.canonicalName}`}>
                  {entry.message}
                </div>
              ))}
          </Kv>
        )}
        <Kv k="Reachable by">{reachableBy(declared, agents, app, member)}</Kv>
        {family !== "tools" ? null : <Kv k="Redaction">{redactionText(row, member)}</Kv>}
      </div>
    </section>
  );
}

/** §13's "Reachable by" line for one tool: every agent the DOOR lets through, named with the
 *  entries that did it — the same computation /apps/<slug> prints, over every agent. */
function reachableBy(declared: RoleDeclaration, agents: ListedAgent[], app: string, tool: string): string {
  const grants: Record<string, string[]> = {};
  for (const agent of agents) {
    const held = agent.grants[app] ?? [];
    if (held.length > 0) grants[agent.slug] = held;
  }
  const reached = reachabilityFor(declared, grants).reach(tool, "tools");
  if (reached.length === 0) return "nobody";
  return reached.map((each) => `${each.agent} · via ${each.roles.join(", ")}`).join(", ");
}

/** §7's configured argument paths for one tool, or `none`. */
function redactionText(row: AppRow, tool: string): string {
  const paths = redactPathsIn(row.redact, tool);
  return paths.length === 0 ? "none" : `arguments ${paths.join(", ")}`;
}


/**
 * One declaration's prose as the details header draws it: the hub's BLOCK rendering where the
 * subject has prose, the plain string where it has none to render (a resource's media type),
 * and nothing at all where it says nothing.
 */
function DescriptionNote({
  item,
  family,
  derived,
}: {
  item: ListedItem;
  family: RoleFamily;
  derived: CatalogDerivation | undefined;
}): ReactNode {
  if (family === "resources") {
    const media = item.mimeType ?? "";
    return media === "" ? null : <div className="note">{media}</div>;
  }
  const prose = derived?.description;
  if (prose === undefined || prose.block === "") return null;
  return <div className="note md" dangerouslySetInnerHTML={{ __html: prose.block }} />;
}
