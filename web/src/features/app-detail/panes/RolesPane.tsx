/**
 * `/apps/<slug>/roles` — the role listing and, beside it, the editor for whichever role
 * `?sel=role:<name>` (or `?new=1`) names.
 *
 * A port of `server/src/pages/app-detail.tsx`'s Roles pane and of the derivations behind it
 * (`model.ts`'s `rolesPane` / `roleRow` / `roleDetails`), with one thing that could not come
 * across: the server drew the ticks from the STORED map on every request, because a form POST
 * was the only way to change one. Here the ticks are a local draft, so the owner may tick,
 * filter, tick again and save once.
 *
 * That is exactly why the wire body separates `drawn` from `ticked`. `drawn` is this render's
 * own account of its coverage — every item row it actually put on screen, checked and
 * unchecked alike — and the server removes a literal only when it is drawn and unticked. So a
 * row the `?q=` filter hid is not an unticked one, and a family whose catalog could not be
 * read draws no rows at all and therefore cannot lose a literal. Neither array is ever
 * reconstructed from the other, and neither is ever taken from a refetched catalog.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ApiError } from "@/lib/http";
import { BUILTIN_ROLE } from "@/lib/paths";
import { useAppEditor } from "@/lib/queries";
import type { FamilyPatterns, ListedAgent, RoleFamily, RolesResponse, Violation } from "@/lib/types";
import { Refreshing, Skeleton } from "@/chrome/States";
import { usePreviewTransient } from "@/preview/transient";
import type { AppPaneProps, FamilyView } from "@/features/app-detail/derive";
import { itemProse } from "@/features/agents/grant-editor";
import type { RowProse } from "@/features/agents/GrantRows";
import {
  FAMILY_GROUPS,
  ROLE_FAMILIES,
  derivedOf,
  familyNote,
  grantEntryOf,
  grantsOn,
  isOneItem,
  itemsOf,
  normalizeRole,
  patternText,
  reachabilityFor,
  searchValue,
  subjectsOf,
} from "@/features/app-detail/derive";

/**
 * `PUT /apps/:slug/roles`' body, exactly as `composeOwnerRoles` reads it back.
 *
 * `drawn` and `ticked` are separate fields and neither is optional: a literal in `drawn` but
 * not `ticked` is REMOVED, and a literal in neither keeps whatever is stored. Conflating them
 * would make every filtered save a deletion of everything the filter hid.
 */
type RoleDraft = {
  /** The role being edited, spelled as it is stored; `""` for a new one. */
  was: string;
  /** Its name after this save — the same as `was` unless the owner renamed it. */
  role: string;
  /** The only delete trigger. Absent means "save"; `true` means "remove `was`". */
  delete?: true;
  /** `"<family>/<name>"` per item row this render PUT ON SCREEN, after the filter. */
  drawn: string[];
  /** The subset of `drawn` whose checkbox is on. Always a subset — a row with no checkbox
   *  (one a pattern already reaches) can never be here. */
  ticked: string[];
  /** `"<family>/<pattern>"` per pattern row this render carried. A pattern absent from here
   *  still survives: only `drop` removes one. */
  keeps: string[];
  /** The one `"<family>/<pattern>"` the owner pressed `×` on. */
  drop?: string;
  /** A new pattern, from the filter box's own offer. */
  add?: string;
};

/** Where one role came from, which is also whether the owner may edit it. */
type RoleSource = "built-in" | "app" | "app · replaced yours" | "yours";

/** The whole-catalog role, spelled as patterns so `all` goes through one matcher. */
const ALL_FAMILIES: FamilyPatterns = { tools: [".*"], prompts: [".*"], resources: [".*"] };

/**
 * The Roles pane. Reads nothing of its own: `roles` and the four family views arrive from
 * `AppDetailPage`, which owns every query this pane draws from — so `roles === null` is the
 * page's pending state and the only skeleton here.
 */
export function RolesPane({ slug, app, kind, views, refreshing, roles, agents }: AppPaneProps): ReactNode {
  const search = useSearch({ strict: false });
  const holders = grantsOn(slug, agents).agents;
  const sel = searchValue(search, "sel");
  const isNew = searchValue(search, "new") === "1";
  const selected = sel.startsWith("role:") ? sel.slice("role:".length) : "";

  if (roles === null) {
    return (
      <div className="listing">
        <div className="lh">
          <div className="title-row">
            <span className="listing-title">Roles</span>
            <span className="note">named sets of what this app exposes</span>
          </div>
        </div>
        <div className="scroll">
          <Skeleton rows={4} />
        </div>
      </div>
    );
  }

  const yours = Object.keys(roles.ownerRoles).filter((role) => !(role in roles.declaredRoles)).length;
  const summary =
    `${Object.keys(roles.declaredRoles).length} declared by the app · ${yours} yours · plus the built-in all` +
    (kind === "tunnel"
      ? " · the app's declaration wins when it declares a name you defined"
      : " · a proxied app declares none, so every role is yours");
  const names = [...Object.keys(roles.effective), BUILTIN_ROLE];

  return (
    <>
      <div className="listing">
        <div className="lh">
          <div className="title-row">
            <span className="listing-title">Roles</span>
            <span className="note">named sets of what this app exposes</span>
            <Refreshing active={refreshing} />
          </div>
          <div className="sum">{summary}</div>
        </div>
        <div className="scroll">
          {names.map((role) => (
            <div className="cr" key={role}>
              <div>
                <Link className="row-link mono" to="." search={{ sel: `role:${role}` }}>
                  {role}
                </Link>{" "}
                <SourceBadge source={sourceOf(role, roles)} />
                <div className="cr-detail">
                  {role === BUILTIN_ROLE
                    ? `every tool, prompt and resource, present and future · matches ${matchCount(ALL_FAMILIES, views)}`
                    : `${patternText(roles.effective[role])} · matches ${matchCount(normalizeRole(roles.effective[role] ?? {}), views)}`}
                </div>
              </div>
              <div className="cr-control">
                <Badges badges={holdersOf(role, slug, holders)} empty="held by no agent" />
              </div>
            </div>
          ))}
        </div>
        <div className="save">
          <Link className="btn btn--outline btn--sm" to="." search={{ new: "1" }}>
            New role
          </Link>
        </div>
      </div>
      {/* Keyed on the selection so a different role is a different editor: the draft is
          seeded from the role it belongs to and must never carry over to the next one. The
          FILTER is deliberately not in the key — narrowing the rows keeps the draft, which
          is the whole point of `drawn`. */}
      {isNew || selected !== "" ? (
        <RoleEditor
          key={isNew ? "\u0000new" : selected}
          slug={slug}
          appName={app.name}
          kind={kind}
          views={views}
          roles={roles}
          holders={holders}
          name={isNew ? "" : selected}
          isNew={isNew}
          q={searchValue(search, "q").trim()}
        />
      ) : (
        <div className="details">
          <div className="dh">
            <div className="listing-title">Roles</div>
            <p className="note">Select a role to see what it can do, or add one of your own.</p>
          </div>
          <div className="db">
            <section className="card card--pad">
              <div className="eyebrow">Two sources, one rule</div>
              <div className="kv">
                <Kv k="The app's">
                  {kind === "tunnel"
                    ? "declared at connect; read-only here — the app owns them"
                    : "none: a proxied app declares no roles"}
                </Kv>
                <Kv k="Yours">
                  defined here by ticking items or adding patterns; usable in grants like any role
                </Kv>
                <Kv k="Collision">
                  if the app later declares a name you defined, its declaration replaces yours — the row says so
                </Kv>
              </div>
            </section>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------------------------------------------------------------- the editor --- */

/** What the owner has changed since the editor opened — and nothing else. Stored values are
 *  read from `roles` on every render; only these three are the draft. */
type RoleEdit = {
  /** The name field. Typed for a new role, fixed for a saved one. */
  role: string;
  /** `"<family>/<name>"` literals currently ticked. */
  ticked: readonly string[];
  /** `"<family>/<pattern>"` patterns the role holds. Pressing `×` saves with `drop`, so this
   *  only ever grows (by `add`, once the save lands). */
  patterns: readonly string[];
};

function RoleEditor({
  slug,
  appName,
  kind,
  views,
  roles,
  holders,
  name,
  isNew,
  q,
}: {
  slug: string;
  appName: string;
  kind: AppPaneProps["kind"];
  views: Record<RoleFamily, FamilyView>;
  roles: RolesResponse;
  holders: ListedAgent[];
  name: string;
  isNew: boolean;
  q: string;
}): ReactNode {
  const navigate = useNavigate();
  const transient = usePreviewTransient();
  const editor = useAppEditor<RoleDraft>(slug, "roles");
  const [refusal, setRefusal] = useState<{ reason: string; violations?: Violation[] } | null>(
    () => transient.refusal ?? null,
  );

  const source: RoleSource = isNew ? "yours" : sourceOf(name, roles);
  const editable = source === "yours";
  const builtin = !isNew && name === BUILTIN_ROLE;
  const stored: FamilyPatterns = isNew
    ? {}
    : builtin
      ? ALL_FAMILIES
      : normalizeRole((editable ? roles.ownerRoles[name] : roles.effective[name]) ?? {});

  const [edit, setEdit] = useState<RoleEdit>(() => ({ role: name, ...seedOf(stored) }));

  // What the editor renders FROM. An editable role renders its draft, so a tick is visible
  // before it is saved; a read-only one has no draft to render and renders what is stored.
  const families = useMemo(
    () => (editable ? familiesFrom([...edit.ticked, ...edit.patterns]) : stored),
    [editable, edit.ticked, edit.patterns, stored],
  );

  const listing = useMemo(
    () => itemGroups({ app: slug, views, families, q, editable, builtin }),
    [slug, views, families, q, editable, builtin],
  );
  const patterns = useMemo(
    () => patternRows({ views, families, builtin, editable }),
    [views, families, builtin, editable],
  );
  const offerFamily: RoleFamily = q.includes("://") ? "resources" : "tools";
  const offer =
    editable && q !== "" && !isOneItem(q, offerFamily)
      ? {
          pattern: q,
          family: offerFamily,
          detail: `would match ${countMatching(views[offerFamily], offerFamily, { [offerFamily]: [q] })} today, and any added later`,
        }
      : null;
  const catalogNote =
    !builtin && FAMILY_GROUPS.every(({ family }) => views[family].state !== "listed")
      ? "The catalog could not be read, so items cannot be ticked; patterns can still be edited."
      : null;

  const save = (extra: Pick<RoleDraft, "delete" | "drop" | "add"> = {}): void => {
    setRefusal(null);
    editor.mutate(
      {
        was: isNew ? "" : name,
        role: edit.role.trim(),
        drawn: listing.drawn,
        ticked: listing.ticked,
        keeps: patterns.map((row) => row.entry),
        ...extra,
      },
      {
        // A refusal stays HERE: the draft is on screen and the reason belongs beside it. The
        // server-rendered page had to redirect and re-fill the form; this one has nothing to
        // re-fill, which is what makes the 422 arm the whole story.
        onError: (error) =>
          setRefusal(
            error instanceof ApiError
              ? { reason: error.message, violations: error.violations }
              : { reason: error.message },
          ),
      },
    );
  };

  const nameViolations = (refusal?.violations ?? []).filter((each) => NAME_FIELDS.has(each.field));
  const otherViolations = (refusal?.violations ?? []).filter((each) => !NAME_FIELDS.has(each.field));

  return (
    <div className="details">
      <div className="dh">
        <div className="title-row">
          {isNew ? (
            <input
              className="input role-name"
              type="text"
              value={edit.role}
              placeholder="role name"
              pattern="[a-z0-9_\-]+"
              aria-label="Role name"
              onChange={(event) => setEdit((current) => ({ ...current, role: event.target.value }))}
            />
          ) : (
            <span className="listing-title mono">{name}</span>
          )}
          <span className={source === "yours" ? "badge badge--success" : "badge badge--muted"}>
            {source === "built-in" ? "built-in" : source === "yours" ? "yours" : "declared by the app"}
          </span>
          <span className="title-row-end">
            <Badges
              badges={isNew ? [] : holdersOf(name, slug, holders)}
              empty={isNew ? "" : "held by no agent"}
            />
          </span>
        </div>
        <p className="note">{explain(name, source, kind, appName, isNew)}</p>
        {nameViolations.length === 0 ? null : (
          <p className="note" role="alert">
            {nameViolations.map((each) => each.reason).join(" · ")}
          </p>
        )}
        {editable ? (
          <form
            className="lh-filter"
            onSubmit={(event) => {
              event.preventDefault();
              const typed = new FormData(event.currentTarget).get("q");
              const next = typeof typed === "string" ? typed.trim() : "";
              void navigate({
                to: ".",
                search: {
                  ...(isNew ? { new: "1" } : { sel: `role:${name}` }),
                  ...(next === "" ? {} : { q: next }),
                },
              });
            }}
          >
            {/* Uncontrolled and re-keyed on the URL: the filter's value IS `?q=`, so the
                input is re-seeded when a navigation changes it and typed into freely between
                navigations. */}
            <input
              key={q}
              type="search"
              name="q"
              defaultValue={q}
              placeholder="filter, or type a pattern…"
              aria-label="Filter"
            />
          </form>
        ) : null}
      </div>
      <Refusal reason={refusal?.reason ?? null} violations={otherViolations} />
      {/* A read-only role — the app's own declaration, and the built-in `all` — draws no Save
          at all: its rows are statements, and a Save would have nothing it is allowed to
          write. */}
      <div className="listing-form">
        <div className="scroll">
          {catalogNote === null ? null : <p className="note gh-state">{catalogNote}</p>}
          {listing.groups.map((group) => (
            <div key={group.title}>
              <div className="gh sticky">
                <span>
                  {group.title}
                  {group.count === null ? null : ` · ${group.count}`}
                </span>
              </div>
              {group.state === null ? (
                group.rows.map((row) => (
                  <div className="cr" key={row.entry}>
                    <div>
                      <span className="mono">{row.name}</span>
                      <div className="cr-detail">
                        {/* The hub's own renderer already escaped and whitelisted this
                            (`pages/markdown.ts`), which is why injecting it here is safe and
                            why the client must never render an app's raw prose itself. A
                            resource row carries no prose, only a media type. */}
                        {row.prose.html === null ? (
                          <span className="md">{row.prose.text}</span>
                        ) : (
                          <span className="md" dangerouslySetInnerHTML={{ __html: row.prose.html }} />
                        )}
                        {row.via.length === 0 ? null : (
                          <>
                            {" "}
                            · via <span className="mono">{row.via.join(", ")}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="cr-control">
                      {row.locked ? (
                        <span className="cb lock" title={row.lockTitle}>
                          <Check />
                        </span>
                      ) : row.tickable ? (
                        <input
                          className="cb"
                          type="checkbox"
                          checked={row.checked}
                          aria-label={row.name}
                          onChange={() =>
                            setEdit((current) => ({
                              ...current,
                              ticked: current.ticked.includes(row.entry)
                                ? current.ticked.filter((each) => each !== row.entry)
                                : [...current.ticked, row.entry],
                            }))
                          }
                        />
                      ) : (
                        <span className="cb" title={row.lockTitle} aria-hidden="true"></span>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <p className="note gh-state">{group.state}</p>
              )}
            </div>
          ))}
          {patterns.length === 0 && offer === null ? null : (
            <>
              <div className="gh sticky">
                <span>Patterns · {patterns.length}</span>
                <span className="gh-note">anchored · * aliases .*</span>
              </div>
              {patterns.map((row) => (
                <div className="cr" key={row.entry}>
                  <div>
                    <span className="mono">{row.pattern}</span> <span className="ty">{row.family}</span>
                    <div className="cr-detail">{row.detail}</div>
                  </div>
                  <div className="cr-control">
                    {row.editable ? (
                      <button
                        type="button"
                        className="cb on"
                        title="remove this pattern"
                        disabled={editor.isPending}
                        onClick={() => save({ drop: row.entry })}
                      >
                        <Check />
                      </button>
                    ) : (
                      <span className="cb lock" title="in this role">
                        <Check />
                      </span>
                    )}
                  </div>
                </div>
              ))}
              {offer === null ? null : (
                <div className="cr">
                  <div>
                    <span className="mono">{offer.pattern}</span> <span className="ty">{offer.family}</span>
                    <div className="cr-detail">{offer.detail}</div>
                  </div>
                  <div className="cr-control">
                    <button
                      type="button"
                      className="btn btn--outline btn--sm"
                      disabled={editor.isPending}
                      onClick={() => save({ add: offer.pattern })}
                    >
                      Add as pattern
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
        {editable ? (
          <div className="save">
            {isNew ? (
              <span></span>
            ) : (
              <span className="save-end">
                <button
                  type="button"
                  className="btn btn--danger-outline btn--sm"
                  disabled={editor.isPending}
                  onClick={() => save({ delete: true })}
                >
                  Delete role
                </button>
                <span className="muted">
                  grants naming it keep the name and match nothing until it exists again
                </span>
              </span>
            )}
            <span className="save-end">
              <Link className="btn btn--ghost btn--sm" to="." search={{}}>
                Discard
              </Link>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                disabled={editor.isPending}
                onClick={() => save()}
              >
                Save
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- the derivations --- */

/** The op's own field names for the role being written — which is what makes a violation
 *  belong under the name input rather than in the alert above the rows. */
const NAME_FIELDS = new Set(["role", "was", "owner_roles", "roles"]);

/** One item row, as the editor draws it. */
type ItemRow = {
  /** `"<family>/<name>"` — the string `drawn` and `ticked` both speak in. */
  entry: string;
  name: string;
  /**
   * What the row prints under the name, in the shared two-part shape.
   *
   * `html` is `pages/markdown.ts`'s own one-line rendering of the app's untrusted prose — the
   * hub's ONE audited renderer, whose whitelist is why this is the one place markup may be
   * injected — and is null where the line is not prose at all (a resource's media type).
   * `text` is what the FILTER matches on: a needle must not be able to hit a markdown
   * delimiter the reader never saw.
   */
  prose: RowProse;
  /** The non-literal patterns that already reach this row, for the `via` line. */
  via: string[];
  /** Whether this render gave the row a checkbox at all. A locked row did not. */
  tickable: boolean;
  checked: boolean;
  locked: boolean;
  lockTitle: string;
};

/**
 * The three family groups, the rows in them, and — the two arrays the save depends on —
 * exactly what was drawn and exactly what came back ticked.
 *
 * `drawn` collects AFTER the filter and only for a `listed` family, because those are the two
 * ways a row can be absent from the screen while its literal is still stored. `ticked` is
 * collected from the rows that actually carried a checkbox, so it is a subset of `drawn` by
 * construction rather than by a later intersection.
 *
 * A family that could not be read still gets a HEADING with `familyNote`'s one sentence under
 * it, rather than vanishing: unread is not empty, and a group that quietly disappeared would
 * read as "this app declares nothing here". It contributes nothing to `drawn`, which is what
 * makes a save against it leave every stored literal alone.
 */
function itemGroups({
  app,
  views,
  families,
  q,
  editable,
  builtin,
}: {
  /** The app's slug — `familyNote`'s never-connected sentence names it. */
  app: string;
  views: Record<RoleFamily, FamilyView>;
  families: FamilyPatterns;
  q: string;
  editable: boolean;
  builtin: boolean;
}): {
  groups: { title: string; count: string | null; rows: ItemRow[]; state: string | null }[];
  drawn: string[];
  ticked: string[];
} {
  const door = reachabilityFor({ role: families }, { role: ["role"] });
  const needle = q.toLowerCase();
  const groups: { title: string; count: string | null; rows: ItemRow[]; state: string | null }[] = [];
  const drawn: string[] = [];
  const ticked: string[] = [];
  for (const { family, title } of FAMILY_GROUPS) {
    const view = views[family];
    // The built-in `all` is a promise about every item, present and future: there is nothing
    // to tick and nothing to say about a family it does not enumerate.
    if (builtin) continue;
    if (view.state !== "listed") {
      // `pending` has no sentence — it is about to become one of the others, and the pane
      // header's refresh indicator is what stands in for it.
      const state = familyNote(view, app, title);
      if (state !== null) groups.push({ title, count: null, rows: [], state });
      continue;
    }
    const items = itemsOf(view);
    const subjects = subjectsOf(view);
    const derived = derivedOf(view);
    if (items.length === 0) continue;
    const patterns = families[family] ?? [];
    let inRole = 0;
    const rows: ItemRow[] = [];
    for (let index = 0; index < items.length; index += 1) {
      const subject = subjects[index] ?? "";
      // ONE reading of what a row's line is, shared with the grant editor: prose for a tool
      // or a prompt, a media type for a resource, and no description at all where the two
      // parallel arrays disagree — never unrendered Markdown source.
      const prose = itemProse(items[index], family, derived[index]);
      const matched = door.reach(subject, family).length > 0;
      if (matched) inRole += 1;
      if (needle !== "" && !subject.toLowerCase().includes(needle) && !prose.text.toLowerCase().includes(needle)) {
        continue;
      }
      const literal = patterns.includes(subject);
      const via = matched && !literal ? patterns.filter((pattern) => !isOneItem(pattern, family)) : [];
      const entry = `${family}/${subject}`;
      const tickable = editable && via.length === 0;
      const checked = editable ? literal : matched;
      drawn.push(entry);
      if (tickable && checked) ticked.push(entry);
      rows.push({
        entry,
        name: subject,
        prose,
        via,
        tickable,
        checked,
        locked: editable ? via.length > 0 : matched,
        lockTitle: editable ? `matched by ${via.join(", ")}` : matched ? "in this role" : "not in this role",
      });
    }
    groups.push({
      title,
      count: `${inRole} of ${items.length}`,
      rows,
      state: rows.length === 0 ? "no match" : null,
    });
  }
  return { groups, drawn, ticked };
}

/** The Patterns section's rows — every entry of the role that is not one item's own name. */
function patternRows({
  views,
  families,
  builtin,
  editable,
}: {
  views: Record<RoleFamily, FamilyView>;
  families: FamilyPatterns;
  builtin: boolean;
  editable: boolean;
}): { pattern: string; family: RoleFamily; detail: string; entry: string; editable: boolean }[] {
  if (builtin) return [];
  return ROLE_FAMILIES.flatMap((family) =>
    (families[family] ?? [])
      .filter((pattern) => !isOneItem(pattern, family))
      .map((pattern) => ({
        pattern,
        family,
        detail: `matches ${countMatching(views[family], family, { [family]: [pattern] })} today, and any added later`,
        entry: `${family}/${pattern}`,
        editable,
      })),
  );
}

/** How many of a family's listed rows one pattern set reaches. Zero for a family that is not
 *  listed — which is a true count of what the reader can see, not a claim about the grant. */
function countMatching(view: FamilyView, family: RoleFamily, patterns: FamilyPatterns): number {
  const door = reachabilityFor({ role: patterns }, { role: ["role"] });
  return subjectsOf(view).filter((subject) => door.reach(subject, family).length > 0).length;
}

/** What a role's whole pattern set matches across every listed family — the `matches N` the
 *  listing prints on every row. */
function matchCount(families: FamilyPatterns, views: Record<RoleFamily, FamilyView>): number {
  const door = reachabilityFor({ role: families }, { role: ["role"] });
  let total = 0;
  for (const family of ROLE_FAMILIES) {
    total += subjectsOf(views[family]).filter((subject) => door.reach(subject, family).length > 0).length;
  }
  return total;
}

/**
 * A stored declaration split the way the editor holds it: literals are the tick set, and
 * everything else is a pattern row. They share one stored list per family (§20.3), so they are
 * told apart the way the door tells them apart — `isOneItem` — and not by a second field.
 */
function seedOf(stored: FamilyPatterns): { ticked: string[]; patterns: string[] } {
  const ticked: string[] = [];
  const patterns: string[] = [];
  for (const family of ROLE_FAMILIES) {
    for (const pattern of stored[family] ?? []) {
      (isOneItem(pattern, family) ? ticked : patterns).push(`${family}/${pattern}`);
    }
  }
  return { ticked, patterns };
}

/** The draft's flat `"<family>/<x>"` entries back as a per-family object — the shape the
 *  matcher takes, and the shape the server will compose. */
function familiesFrom(entries: readonly string[]): FamilyPatterns {
  const families: FamilyPatterns = {};
  for (const entry of entries) {
    const cut = entry.indexOf("/");
    if (cut < 0) continue;
    const family = entry.slice(0, cut) as RoleFamily;
    if (!ROLE_FAMILIES.includes(family)) continue;
    const held = families[family] ?? [];
    const rest = entry.slice(cut + 1);
    if (!held.includes(rest)) held.push(rest);
    families[family] = held;
  }
  return families;
}

/** Where one role came from, and therefore whether it is the owner's to edit. */
function sourceOf(role: string, roles: RolesResponse): RoleSource {
  if (role === BUILTIN_ROLE) return "built-in";
  if (role in roles.declaredRoles) return role in roles.ownerRoles ? "app · replaced yours" : "app";
  return "yours";
}

/** The sentence under the title, one per state a selected role can be in. */
function explain(
  name: string,
  source: RoleSource,
  kind: AppPaneProps["kind"],
  appName: string,
  isNew: boolean,
): string {
  if (source === "built-in") {
    return "Every tool, prompt and resource, present and future. Never declarable, only grantable.";
  }
  if (source === "app") {
    return `Declared by ${appName} at connect. Read-only: the app owns it and may widen it on its next connect.`;
  }
  if (source === "app · replaced yours") {
    return `${appName} declares this name, so its declaration replaced the one you had defined. Read-only: the app owns it.`;
  }
  if (kind === "proxy") {
    return "Defined by you. A proxied app declares no roles, so this is the only kind it has.";
  }
  return `Defined by you. If ${appName} later declares a role named ${isNew && name === "" ? "…" : name}, the app's declaration replaces this one.`;
}

/** Which agents hold this role on this app, and whether they hold it as an ask — the badge
 *  row the listing and the editor header both draw. */
function holdersOf(role: string, slug: string, agents: ListedAgent[]): { agent: string; ask: boolean }[] {
  return agents.flatMap((agent) => {
    const held = (agent.grants[slug] ?? []).map(grantEntryOf).find((entry) => entry.entry === role);
    return held === undefined ? [] : [{ agent: agent.slug, ask: held.mode === "approval" }];
  });
}

/* ------------------------------------------------------------------- the bits --- */

const Kv = ({ k, children }: { k: string; children?: ReactNode }): ReactNode => (
  <div className="kv-row">
    <span className="k">{k}</span>
    <span className="v">{children}</span>
  </div>
);

/** The small source badge: `built-in` / `app` / `app · replaced yours` / `yours`. */
function SourceBadge({ source }: { source: RoleSource }): ReactNode {
  const title =
    source === "app"
      ? "declared by the app at connect"
      : source === "app · replaced yours"
        ? "the app declares this name — its declaration replaced yours"
        : undefined;
  return (
    <span className={source === "yours" ? "badge badge--success badge--xs" : "badge badge--xs"} title={title}>
      {source}
    </span>
  );
}

/** One agent that reaches a row: mono for allow, amber for `· ask`. */
function Badges({ badges, empty }: { badges: { agent: string; ask: boolean }[]; empty: string }): ReactNode {
  if (badges.length === 0) return <span className="muted">{empty}</span>;
  return (
    <>
      {badges.map((badge) => (
        <span key={badge.agent} className={badge.ask ? "badge badge--warning" : "badge badge--mono"}>
          {badge.agent}
          {badge.ask ? " · ask" : ""}
        </span>
      ))}
    </>
  );
}

/** A danger alert above a refused editor — never a navigation, or the draft would be lost. */
function Refusal({ reason, violations }: { reason: string | null; violations: Violation[] }): ReactNode {
  if (reason === null) return null;
  return (
    <div className="alert alert--danger" role="alert">
      <div className="alert-text">
        {reason}
        {violations.map((each) => (
          <div key={`${each.field}:${each.reason}`}>
            <span className="mono">{each.field}</span> {each.reason}
          </div>
        ))}
      </div>
    </div>
  );
}

/** The tick glyph both the checkbox's checked state and the locked ticks draw. */
function Check(): ReactNode {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
