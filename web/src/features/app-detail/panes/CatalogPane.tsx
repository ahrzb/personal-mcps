/**
 * The Catalog pane — §3's three family listings and, beside them, everything the hub knows
 * about the one row the URL selected.
 *
 * A port of `pages/app-detail.tsx`'s `CatalogPane` / `CatalogGroupView` /
 * `CatalogDetailsView` and their builder (`model.ts:catalogPane`, `:catalogDetails`). The
 * listing's THREE non-listed answers are the whole point of the pane and are kept apart
 * exactly as the sheet drew them: a family the app advertises but that could not be read
 * says so, a family it never advertised says something else, and an app that has never
 * connected replaces all three groups with one sentence.
 *
 * Two things are derived here rather than read: the filter, which is the URL's `?q=`, and
 * the reach badges, which no resource reports because reachability is a function of the role
 * declaration and the grants at once (`derive.reachabilityFor`).
 *
 * Item descriptions are rendered as PLAIN TEXT. The server-rendered page ran them through
 * its own Markdown renderer; the client has no renderer and an app's description is
 * upstream text, so injecting it as HTML to get italics would be trading a real hazard for
 * emphasis. The sheet's `.md` class stays on the element so the spacing is unchanged.
 */

import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Kv, KvList } from "@/chrome/Kv";
import {
  Details,
  DetailsBody,
  DetailsHead,
  GroupHead,
  GroupHeadNote,
  Listing,
  ListingHead,
  ListingNote,
  ListingScroll,
  ListingTitle,
  ListRow,
  ListRowControl,
  ListRowDetail,
  RowLink,
  Sum,
} from "@/chrome/Listing";
import { TitleRow } from "@/chrome/Page";
import { Copyable } from "@/chrome/Reveal";
import { Refreshing, Skeleton } from "@/chrome/States";
import { Eyebrow, Muted, Note } from "@/chrome/Text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useAppEnv } from "@/lib/api-context";
import { paths } from "@/lib/paths";
import type { CatalogDerivation, ListedItem, RoleFamily, SchemaLeaf } from "@/lib/types";
import {
  FAMILY_GROUPS,
  catalogIdentity,
  countOf,
  derivedOf,
  grantsOn,
  itemDescription,
  itemsOf,
  plural,
  reachabilityFor,
  redactPathsIn,
  scopedEndpoint,
  searchValue,
} from "../derive";
import type { AppPaneProps, FamilyView, Reach } from "../derive";

export function CatalogPane(props: AppPaneProps): ReactNode {
  const { slug, app, kind, views, roles, agents, refreshing } = props;
  const { bootstrap } = useAppEnv();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as Record<string, string | string[] | undefined>;
  const q = searchValue(search, "q").trim();
  const base = paths.appPane(slug, "catalog");

  const granted = grantsOn(slug, agents);
  const doors = reachabilityFor(roles?.effective ?? {}, granted.grants);

  const subtitle =
    kind === "tunnel"
      ? "advertised by the app on its last connect · re-listed on every reconnect"
      : "fetched live from the upstream";
  const summary = `${plural(countOf(views.tools), "tool")} · ${plural(countOf(views.prompts), "prompt")} · ${plural(
    countOf(views.resources),
    "resource",
  )} · reachable by ${plural(granted.agents.length, "agent")}`;

  // The two whole-pane answers, which stand in place of all three groups: nothing has ever
  // been listed, or nothing could be read just now (§3).
  const unconnected = FAMILY_GROUPS.every((group) => views[group.family].state === "unconnected");
  const unread = FAMILY_GROUPS.some((group) => views[group.family].state === "unread");
  const pending = FAMILY_GROUPS.every((group) => views[group.family].state === "pending");
  const oauth = kind === "proxy" && app.auth === "oauth";
  const state = unconnected
    ? { text: "This app has never connected, so the hub has no catalog to list yet.", reconnect: false }
    : unread
      ? oauth
        ? { text: "Token refresh failed — calls return errors until you reconnect.", reconnect: true }
        : {
            text: `Couldn't reach ${kind === "proxy" ? (app.endpoint ?? slug) : slug} — the live listing failed, so nothing is shown; calls return errors until it answers again.`,
            reconnect: false,
          }
      : null;

  return (
    <>
      <Listing>
        <ListingHead>
          <TitleRow>
            <ListingTitle render={<span />}>Catalog</ListingTitle>
            <Note render={<span />}>{subtitle}</Note>
            {/* Bare, as every other pane's is: `Refreshing` renders nothing when it is not
                refreshing, and a wrapper span would be an empty flex item that the narrow
                `TitleRowEnd` rule (a line of its own) would push down, adding a row gap the
                listing never had. */}
            <Refreshing active={refreshing} />
          </TitleRow>
          <Sum>{summary}</Sum>
          {/* A filter on the URL, not in state: `?q=` is what makes a filtered view
              shareable, and it is also what the Roles editor's save depends on being
              visible — a hidden row is not an unticked one. Every keystroke REPLACES, and
              drops `?sel=`, exactly as submitting the GET form did. */}
          <div className="flex">
            <Input
              type="search"
              value={q}
              placeholder="filter tools, prompts, resources…"
              aria-label="Filter"
              onChange={(event) => {
                const value = event.target.value;
                void navigate({ to: base, search: value === "" ? {} : { q: value }, replace: true });
              }}
            />
          </div>
        </ListingHead>
        <ListingScroll>
          {pending ? (
            <Skeleton rows={6} />
          ) : state !== null ? (
            <Empty variant="inline">
              <EmptyDescription>{state.text}</EmptyDescription>
              {state.reconnect ? (
                <form method="post" action={paths.appConnect(slug)}>
                  <input type="hidden" name="csrf" value={bootstrap.csrf} />
                  <Button type="submit" variant="outline" size="sm" className="mt-4">
                    {app.connection !== undefined && app.connection !== "not_connected" ? "Reconnect" : "Connect"}
                  </Button>
                </form>
              ) : null}
            </Empty>
          ) : (
            FAMILY_GROUPS.map((group) => (
              <FamilyGroup
                key={group.family}
                title={group.title}
                one={group.one}
                family={group.family}
                view={views[group.family]}
                kind={kind}
                q={q}
                doors={doors}
                base={base}
              />
            ))
          )}
        </ListingScroll>
      </Listing>
      {/* `bootstrap.origin`, never `location.origin`: this endpoint is a value the owner
          COPIES into a bot's configuration, so it must be the origin the hub puts on the
          wire everywhere else — a dashboard reached on some other host must not hand out
          an endpoint naming that host. */}
      <CatalogDetails
        props={props}
        search={search}
        doors={doors}
        endpoint={scopedEndpoint(bootstrap.origin, bootstrap.username, slug)}
      />
    </>
  );
}

/* ------------------------------------------------------------- the listing --- */

/**
 * One family's heading and rows. A family that is not listed draws its heading with a zero
 * and one note line in place of rows — the heading stays, because a reader counting three
 * families needs to see the third one to know it is empty rather than missing.
 */
function FamilyGroup({
  title,
  one,
  family,
  view,
  kind,
  q,
  doors,
  base,
}: {
  title: string;
  one: "tool" | "prompt" | "resource";
  family: RoleFamily;
  view: FamilyView;
  kind: "tunnel" | "proxy";
  q: string;
  doors: { reach(subject: string, family: RoleFamily): Reach[] };
  base: string;
}): ReactNode {
  if (view.state !== "listed") {
    return (
      <>
        <GroupHead>
          <span>{title} · 0</span>
          <GroupHeadNote render={<span />}>none advertised</GroupHeadNote>
        </GroupHead>
        <ListingNote>
          {view.state === "pending"
            ? `Reading ${family}…`
            : kind === "tunnel"
              ? `This app declared no ${family} capability on its last connect.`
              : `The capabilities configured for this app omit ${family}.`}
        </ListingNote>
      </>
    );
  }
  const needle = q.toLowerCase();
  const items = itemsOf(view);
  const derived = derivedOf(view);
  const rows = items.flatMap((item, index) => {
    const derivation = derived[index];
    if (derivation === undefined) return [];
    const name = derivation.subject;
    // A resource row prints its MIME TYPE, not its description (§20.3 — that is what the
    // board draws under a URI), and a MIME type is not prose. Every other family prints the
    // declaration's own description, rendered.
    const mime = family === "resources" ? itemDescription(item, family) : null;
    // The needle matches the name and the DETAIL AS THE READER SEES IT — `plainText`'s
    // form, which is what `plainText` exists for. Not the raw Markdown source: typing `**`
    // or `](` would then "match" rows whose visible text contains neither. Not the rendered
    // HTML either: the needle would have to step over tags. The Roles editor and both grant
    // editors filter by the same rule, so one needle finds one row set everywhere.
    const visible = mime ?? derivation.description.text;
    if (needle !== "" && !name.toLowerCase().includes(needle) && !visible.toLowerCase().includes(needle)) {
      return [];
    }
    return [{ name, mime, inline: derivation.description.inline }];
  });
  return (
    <>
      <GroupHead>
        <span>
          {title} · {items.length}
        </span>
      </GroupHead>
      {rows.length === 0 ? (
        <ListingNote>no match</ListingNote>
      ) : (
        rows.map((row) => (
          <ListRow key={row.name}>
            <div>
              <RowLink
                className="font-mono"
                render={<Link to={base} search={q === "" ? { sel: `${one}:${row.name}` } : { q, sel: `${one}:${row.name}` }} />}
              >
                {row.name}
              </RowLink>
              {row.mime === null ? (
                // The renderer's whitelist strips id/class/style and escapes raw HTML, and
                // it is the hub's ONE audited renderer of untrusted app prose — which is
                // what makes this safe here and nowhere else. Never build markup from a
                // raw `description`.
                <ListRowDetail className="md" dangerouslySetInnerHTML={{ __html: row.inline }} />
              ) : (
                <ListRowDetail className="md">{row.mime}</ListRowDetail>
              )}
            </div>
            <ListRowControl>
              <Badges reached={doors.reach(row.name, family)} empty="no agent" />
            </ListRowControl>
          </ListRow>
        ))
      )}
    </>
  );
}

/** One agent that reaches a row: mono for allow, amber for `· ask` (§3/§4). */
function Badges({ reached, empty }: { reached: Reach[]; empty: string }): ReactNode {
  if (reached.length === 0) return <Muted>{empty}</Muted>;
  return (
    <>
      {reached.map((entry) => (
        <Badge key={entry.agent} variant={entry.mode === "approval" ? "warning" : "mono"}>
          {entry.mode === "approval" ? `${entry.agent} · ask` : entry.agent}
        </Badge>
      ))}
    </>
  );
}

/* ------------------------------------------------------------- the details --- */

/**
 * The selected row, or the explanation of where the listing comes from. `?sel=` is validated
 * against the rows in hand — a selection naming nothing draws the unselected card, never an
 * empty one — which is the same decision the loader made and is why a stale link degrades
 * instead of breaking.
 */
function CatalogDetails({
  props,
  search,
  doors,
  endpoint,
}: {
  props: AppPaneProps;
  search: Record<string, string | string[] | undefined>;
  doors: { reach(subject: string, family: RoleFamily): Reach[] };
  /** This app's scoped MCP endpoint — the only URL its resources are served on (§3). */
  endpoint: string;
}): ReactNode {
  const { slug, app, kind, views, diagnostics } = props;
  const sel = searchValue(search, "sel");
  const cut = sel.indexOf(":");
  const group = cut < 0 ? undefined : FAMILY_GROUPS.find((entry) => entry.one === sel.slice(0, cut));
  const name = cut < 0 ? "" : sel.slice(cut + 1);
  const view = group === undefined ? undefined : views[group.family];
  const index = view === undefined ? -1 : derivedOf(view).findIndex((each) => each.subject === name);

  if (group === undefined || view === undefined || index < 0) {
    return (
      <Details>
        <DetailsHead>
          <ListingTitle>Catalog</ListingTitle>
          <Note>Select a tool, prompt or resource for its details.</Note>
        </DetailsHead>
        <DetailsBody>
          <Card size="sm" render={<section />}>
            <Eyebrow>Where this comes from</Eyebrow>
            <KvList>
              <Kv k="Schemas">
                {kind === "tunnel"
                  ? "the app's last tools/list — the hub stores them, it does not author them"
                  : "the upstream's live listing, under a 10 s deadline"}
              </Kv>
              <Kv k="Reach">computed with the gate's own matcher over each agent's grant</Kv>
            </KvList>
          </Card>
        </DetailsBody>
      </Details>
    );
  }

  const item = itemsOf(view)[index] as ListedItem;
  const derived = derivedOf(view)[index] as CatalogDerivation;
  const family = group.family;
  const isResource = family === "resources";
  const reached = doors.reach(name, family);
  const identity = catalogIdentity(app, diagnostics, slug, family, name, endpoint);

  // A prompt declares ARGUMENTS, not a schema (§20.3), so its card is the declaration where
  // a tool's is the schema's dotted leaves.
  const args = family === "tools" ? derived.argPaths : null;
  const declared = family === "prompts" ? derived.promptArguments : null;
  const results = family === "tools" && derived.resultPaths.length > 0 ? derived.resultPaths : null;

  const redactedArgs = [
    ...new Set([...redactPathsIn(app.redact, name), ...(args ?? []).filter((leaf) => leaf.writeOnly).map((leaf) => leaf.path)]),
  ];
  const redactedResults = [...new Set(redactPathsIn(app.redactResults, name))];
  const asked = reached.filter((entry) => entry.mode === "approval").map((entry) => entry.agent);

  return (
    <Details>
      <DetailsHead>
        <TitleRow>
          <ListingTitle render={<span />} className="font-mono">{name}</ListingTitle>
          <Badge variant="muted">{group.one}</Badge>
        </TitleRow>
        {derived.description.block === "" ? null : (
          // The details card is the BLOCK form: paragraphs and lists, where a row gets one
          // line. Both come from `pages/markdown`, the hub's one audited renderer.
          <Note render={<div />} className="md" dangerouslySetInnerHTML={{ __html: derived.description.block }} />
        )}
      </DetailsHead>
      <DetailsBody>
        {isResource ? (
          <Card size="sm" render={<section />}>
            <Eyebrow>Resource</Eyebrow>
            <KvList>
              <Kv k="URI">
                <span className="font-mono">{name}</span>
              </Kv>
              <Kv k="Type">{itemDescription(item, "resources") === "" ? "—" : itemDescription(item, "resources")}</Kv>
              <Kv k="Served on">
                the scoped endpoint only — <Copyable value={endpoint} />
              </Kv>
              <Kv k="Matched">by URI, never by name</Kv>
            </KvList>
          </Card>
        ) : null}
        {args === null ? null : <LeafCard title="Arguments" rows={args} />}
        {declared === null ? null : <DeclaredCard rows={declared} />}
        {results === null ? null : <LeafCard title="Result · outputSchema" rows={results} />}
        <Card size="sm" render={<section />}>
          <Eyebrow>What only the hub knows</Eyebrow>
          <KvList>
            <Kv k="Scoped MCP identity">
              <div>
                <span className="font-mono">{identity.scoped.service}</span>
                {" / "}
                <span className="font-mono">{identity.scoped.member}</span>
              </div>
              <Copyable value={identity.scoped.endpoint} />
            </Kv>
            {identity.typescript === null ? null : (
              <Kv k="TypeScript identity">
                <div>
                  {identity.typescript.path === null ? (
                    "unavailable"
                  ) : (
                    <span className="font-mono">{identity.typescript.path}</span>
                  )}
                  {identity.typescript.source === null ? null : ` · ${identity.typescript.source}`}
                </div>
                {identity.typescript.diagnostic === null ? null : (
                  <FieldError>{identity.typescript.diagnostic}</FieldError>
                )}
              </Kv>
            )}
            <Kv k="Reachable by">
              {reached.length === 0
                ? "no agent yet"
                : reached.map((entry) => <div key={entry.agent}>{`${entry.agent} · via ${entry.roles.join(", ")}`}</div>)}
            </Kv>
            {isResource ? null : (
              <Kv k="Approval">
                {family === "prompts"
                  ? "never asked for prompts"
                  : asked.length === 0
                    ? "none required"
                    : `asked for ${asked.join(", ")}`}
              </Kv>
            )}
            {isResource ? null : <Kv k="Redaction">{redactionText(redactedArgs, redactedResults)}</Kv>}
          </KvList>
        </Card>
        <Note>
          The same block the audit row and the agent page show for this {group.one}. Editing reach happens on{" "}
          <Link to={paths.appPane(slug, "access")}>Agents</Link>, masking on{" "}
          <Link to={paths.appPane(slug, "recording")}>Recording</Link>.
        </Note>
      </DetailsBody>
    </Details>
  );
}

/** What this member's bodies lose before they are recorded, in one line: the two directions
 *  said separately, because a mask on an argument and a mask on a result are different
 *  decisions made in different rows of the Recording pane. */
function redactionText(args: string[], results: string[]): string {
  if (args.length === 0 && results.length === 0) return "no redacted fields";
  return [args.length === 0 ? "" : `arguments ${args.join(", ")}`, results.length === 0 ? "" : `results ${results.join(", ")}`]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * One schema row of the Arguments / Result card: path, type, and whatever the third column has
 * to say, on one baseline, over a hairline (none under the last). The path yields and breaks
 * mid-token rather than widen the card; on a phone the third column drops under the first two.
 */
const ARG_ROW =
  "grid grid-cols-[minmax(0,1fr)_70px_minmax(0,1fr)] items-baseline gap-x-2.5 border-b border-row-border py-1 text-xs last:border-b-0 [&>:first-child]:min-w-0 [&>:first-child]:wrap-anywhere max-md:grid-cols-[minmax(0,1fr)_auto] max-md:[&>:nth-child(3)]:col-span-full";

/** A tool's schema as dotted leaves — the Arguments and Result cards. `writeOnly` is §7's
 *  marker: masked regardless of configuration, so the row says so rather than offering a
 *  control the owner cannot use from here. */
function LeafCard({ title, rows }: { title: string; rows: SchemaLeaf[] }): ReactNode {
  return (
    <Card size="sm" render={<section />}>
      <Eyebrow>{title}</Eyebrow>
      {rows.length === 0 ? (
        <Note>none</Note>
      ) : (
        rows.map((row) => (
          <div className={ARG_ROW} key={row.path}>
            <div className="font-mono">{row.path}</div>
            <Muted render={<div />}>{row.type}</Muted>
            <div>{row.writeOnly ? <Badge variant="warning">writeOnly · masked</Badge> : null}</div>
          </div>
        ))
      )}
    </Card>
  );
}

/**
 * A PROMPT's declared arguments, relayed as the app wrote them: no type column, because a
 * prompt carries no JSON Schema and printing one would invent a fact (§20.3). This is the
 * one place a per-argument description exists at all — a schema property has a type and a
 * default, not prose — and it arrives already rendered by the hub's one audited renderer.
 */
function DeclaredCard({ rows }: { rows: CatalogDerivation["promptArguments"] }): ReactNode {
  return (
    <Card size="sm" render={<section />}>
      <Eyebrow>Arguments</Eyebrow>
      {rows.length === 0 ? (
        <Note>none</Note>
      ) : (
        rows.map((row) => (
          <div className={ARG_ROW} key={row.name}>
            <div className="font-mono">{row.name}</div>
            {row.description.inline === "" ? (
              <Muted render={<div />} className="md">—</Muted>
            ) : (
              <Muted render={<div />} className="md" dangerouslySetInnerHTML={{ __html: row.description.inline }} />
            )}
            <Muted render={<div />}>{row.required ? "required" : "optional"}</Muted>
          </div>
        ))
      )}
    </Card>
  );
}
