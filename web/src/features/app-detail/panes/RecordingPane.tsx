/**
 * `/apps/<slug>/recording` — the body-logging switch and the two mask tables.
 *
 * A port of `server/src/pages/app-detail.tsx`'s Recording pane and `model.ts`'s
 * `recordingPane` / `recordingSection` / `maskedCard`. The paths are not asked for: they are
 * the leaves of each tool's `inputSchema` and `outputSchema`, which the API already derives
 * (`CatalogDerivation.argPaths` / `resultPaths`) so the browser holds no second copy of
 * `schemaLeaves`.
 *
 * The save carries `drawn` — one `(path, tools)` pair per path row this render put on screen —
 * for the reason `composeRedaction` states: a pair not named there keeps whatever is stored,
 * so a path the filter hid, a tool the upstream stopped listing, and a mask entered from
 * evidence that no schema declares are all left exactly alone. No catalog is re-read at save
 * time, here or on the server.
 *
 * `wholePath` carries only ENABLED checked path controls. A `writeOnly` path's control is
 * checked and disabled (§7 masks it regardless, and it is not the owner's to clear), and an
 * expanded path's control is disabled because the per-tool rows below it ARE the control.
 * Including either would OR-cancel the per-tool unticking the owner just did.
 */

import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ApiError } from "@/lib/http";
import { useAppEditor } from "@/lib/queries";
import type { Violation } from "@/lib/types";
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
  ListRowType,
  SaveBar,
  SaveBarEnd,
  Sum,
} from "@/chrome/Listing";
import { TitleRow, TitleRowEnd } from "@/chrome/Page";
import { Refreshing, Skeleton } from "@/chrome/States";
import { Eyebrow, Note } from "@/chrome/Text";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, Tick } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePreviewTransient } from "@/preview/transient";
import type { AppPaneProps, FamilyView } from "@/features/app-detail/derive";
import { derivedOf, itemsOf, plural, searchValue, searchValues } from "@/features/app-detail/derive";

/** `PUT /apps/:slug/recording`'s body — `composeRedaction` applied once per direction, plus
 *  the one boolean that is not a mask. */
type RecordingDraft = {
  /** Whether request and result bodies reach the trail at all (§5). */
  logBodies: boolean;
  /** The `inputSchema` direction — `app_update`'s `redact`. */
  args: RedactionDraft;
  /** The `outputSchema` direction — `app_update`'s `redact_results`. */
  results: RedactionDraft;
};

/** One direction's deltas. Everything outside `drawn` is untouched by the save. */
type RedactionDraft = {
  /** `[path, tools]` per path row this render drew — its own account of its coverage. The
   *  tools are the EDITABLE ones, so a `writeOnly` pair never enters the configuration. */
  drawn: [path: string, tools: string[]][];
  /** Paths whose "all tools" box is ticked AND enabled. */
  wholePath: string[];
  /** `"<tool>.<path>"` per ticked per-tool box. */
  perTool: string[];
};

/** The two directions, in the order the pane draws them. */
const DIRECTIONS = ["args", "results"] as const;
type Direction = (typeof DIRECTIONS)[number];

/** One path, indexed across every tool that takes it. */
type PathEntry = {
  /** The leaf's declared JSON type, from the first tool that declared the path. */
  type: string;
  /** Every tool taking this path, with the app's own `writeOnly` marker on each. */
  tools: { tool: string; writeOnly: boolean }[];
};

/**
 * The Recording pane. Reads nothing of its own — the tools family and the app row arrive from
 * `AppDetailPage` — so the only pending state is the tools view's own.
 */
export function RecordingPane({ slug, app, kind, views, refreshing }: AppPaneProps): ReactNode {
  const search = useSearch({ strict: false });
  const navigate = useNavigate();
  const transient = usePreviewTransient();
  const editor = useAppEditor<RecordingDraft>(slug, "recording");
  const [refusal, setRefusal] = useState<{ reason: string; violations?: Violation[] } | null>(
    () => transient.refusal ?? null,
  );

  // The draft is the per-(tool, path) mask set, seeded from what is stored. Every control on
  // the pane is a reading of it: the path box is ticked when every editable tool of that path
  // is in the set, which is the same rule the server-rendered page applied to the stored map.
  const [draft, setDraft] = useState(() => ({
    logBodies: app.logBodies,
    args: markSet(app.redact),
    results: markSet(app.redactResults),
  }));

  const q = searchValue(search, "q").trim();
  const open = searchValues(search, "which");
  const index = useMemo(
    () => ({ args: pathIndexOf(views.tools, "args"), results: pathIndexOf(views.tools, "results") }),
    [views.tools],
  );

  if (views.tools.state === "pending") {
    return (
      <Listing>
        <ListingHead>
          <TitleRow split>
            <ListingTitle render={<span />}>Recording</ListingTitle>
            <Note render={<span />}>what the audit trail keeps, and what it masks</Note>
          </TitleRow>
        </ListingHead>
        <ListingScroll>
          <Skeleton rows={5} />
        </ListingScroll>
      </Listing>
    );
  }

  const sections: Record<Direction, MaskSection> = {
    args: sectionOf({ dir: "args", index: index.args, marks: draft.args, view: views.tools, q: q.toLowerCase(), open }),
    results: sectionOf({
      dir: "results",
      index: index.results,
      marks: draft.results,
      view: views.tools,
      q: q.toLowerCase(),
      open,
    }),
  };

  // The summary, the cards and the intro all describe what is SAVED, exactly as the
  // server-rendered pane did: they are statements about the stored configuration, and the
  // switch and the boxes above them are the edit that has not been made yet.
  const masked = Object.values(app.redact).flat().length + Object.values(app.redactResults).flat().length;
  const declared = DIRECTIONS.reduce(
    (total, dir) =>
      total + [...index[dir].values()].flatMap((entry) => entry.tools).filter((tool) => tool.writeOnly).length,
    0,
  );
  const logDefault = app.logBodies === (kind === "tunnel");
  const summary =
    `body logging ${app.logBodies ? "on" : "off"} · ${logDefault ? `${kind === "tunnel" ? "tunneled" : "proxied"} default` : "set explicitly"} · ${plural(masked, "masked path")} by config` +
    (declared === 0 ? "" : ` · ${declared} declared writeOnly by the app`);
  const warning =
    kind === "proxy" && app.logBodies && masked === 0
      ? "A proxied app's schema is not cached at call time, so nothing is masked automatically. Tick what is secret before you save, or it is stored in the clear for 7 days."
      : null;

  const save = (): void => {
    setRefusal(null);
    editor.mutate(
      {
        logBodies: draft.logBodies,
        args: bodyOf(sections.args),
        results: bodyOf(sections.results),
      },
      {
        onError: (error) =>
          setRefusal(
            error instanceof ApiError
              ? { reason: error.message, violations: error.violations }
              : { reason: error.message },
          ),
      },
    );
  };

  /** One per-tool box, or one path box over every editable tool of its row. */
  const setMarks = (dir: Direction, pairs: readonly string[], on: boolean): void =>
    setDraft((current) => {
      const next = new Set(current[dir]);
      for (const pair of pairs) {
        if (on) next.add(pair);
        else next.delete(pair);
      }
      return { ...current, [dir]: next };
    });

  return (
    <>
      <Listing>
        <ListingHead>
          <TitleRow split>
            <ListingTitle render={<span />}>Recording</ListingTitle>
            <Note render={<span />}>what the audit trail keeps, and what it masks</Note>
            <Refreshing active={refreshing} />
            {/* The label is visible text, so the state is readable without the colour. It is
                the row's end itself rather than sitting in a wrapper. */}
            <TitleRowEnd
              render={
                <Label className="inline-flex cursor-pointer items-center gap-2 text-xs font-normal whitespace-nowrap text-muted-foreground" />
              }
            >
              <span>Record call bodies</span>
              <Switch
                checked={draft.logBodies}
                onCheckedChange={(checked) => setDraft((current) => ({ ...current, logBodies: checked }))}
              />
            </TitleRowEnd>
          </TitleRow>
          <Sum>{summary}</Sum>
          <form
            className="flex"
            onSubmit={(event) => {
              event.preventDefault();
              const typed = new FormData(event.currentTarget).get("q");
              const next = typeof typed === "string" ? typed.trim() : "";
              void navigate({ to: ".", search: next === "" ? {} : { q: next } });
            }}
          >
            <Input key={q} type="search" name="q" defaultValue={q} placeholder="filter paths…" aria-label="Filter" />
          </form>
        </ListingHead>
        {warning === null ? null : (
          <Alert variant="warning" role="status">
            <AlertDescription>{warning}</AlertDescription>
          </Alert>
        )}
        {refusal === null ? null : (
          <Alert variant="danger" role="alert">
            <AlertDescription>
              {refusal.reason}
              {(refusal.violations ?? []).map((each) => (
                <div key={`${each.field}:${each.reason}`}>
                  <span className="font-mono">{each.field}</span> {each.reason}
                </div>
              ))}
            </AlertDescription>
          </Alert>
        )}
        {/* The rows and the save bar, laid out as the listing's own children. */}
        <div className="contents">
          <ListingScroll>
            {DIRECTIONS.map((dir) => (
              <Section
                key={dir}
                section={sections[dir]}
                q={q}
                open={open}
                onTool={(pair, on) => setMarks(dir, [pair], on)}
                onPath={(pairs, on) => setMarks(dir, pairs, on)}
              />
            ))}
          </ListingScroll>
          <SaveBar>
            <a href={`/audit?app=${encodeURIComponent(slug)}`}>Recorded calls to {slug} →</a>
            <SaveBarEnd render={<span />}>
              <Link className={buttonVariants({ variant: "ghost", size: "sm" })} to="." search={{}}>
                Discard
              </Link>
              <Button size="sm" disabled={editor.isPending} onClick={save}>
                Save
              </Button>
            </SaveBarEnd>
          </SaveBar>
        </div>
      </Listing>
      <Details>
        <DetailsHead>
          <ListingTitle>Masked before recording</ListingTitle>
          <Note>
            {app.logBodies
              ? "These fields are replaced with ‹redacted› before a call is written to the trail. Everything else in the body is kept as sent."
              : "Body logging is off, so no bodies reach the trail; the masks below apply once it is turned on."}
          </Note>
        </DetailsHead>
        <DetailsBody>
          {DIRECTIONS.map((dir) => (
            <MaskedCard
              key={dir}
              dir={dir}
              stored={dir === "args" ? app.redact : app.redactResults}
              index={index[dir]}
            />
          ))}
          <Card size="sm" render={<section />}>
            <Eyebrow>What a recorded call keeps</Eyebrow>
            <KvList>
              <Kv plainKey k="Arguments">
                <span className="font-mono">params.arguments</span>, post-redaction
              </Kv>
              <Kv plainKey k="Results">
                <span className="font-mono">structuredContent</span> post-redaction; text, image and resource blocks
                become size stubs, never bytes
              </Kv>
              <Kv plainKey k="Cap">
                16 KiB per body — an over-cap body is one <span className="font-mono">oversize</span> stub
              </Kv>
              <Kv plainKey k="Kept for">
                7 days, then pruned with the rest of the audit table ·{" "}
                <a href={`/audit/export.jsonl?app=${encodeURIComponent(slug)}`}>Export JSONL</a> to keep longer
              </Kv>
              <Kv plainKey k="Never">
                refused calls, token material, <span className="font-mono">writeOnly</span> and config-masked fields
              </Kv>
            </KvList>
          </Card>
          <Note>
            A tick writes one literal (tool, path) entry per tool; nothing here is a pattern and nothing is typed.
            Masking applies to the approval record too.
          </Note>
        </DetailsBody>
      </Details>
    </>
  );
}

/* --------------------------------------------------------------- the sections --- */

/** One mask row, as the section draws it and as the save reads it. */
type MaskRow = {
  path: string;
  type: string;
  detail: string;
  /** Whether the row offers the `which` / `hide` link — more than one tool, or a declared
   *  `writeOnly` to explain. */
  expandable: boolean;
  expanded: boolean;
  /** The path-level control. `locked` is checked and unclearable; `mixed` is not a control at
   *  all but the dash that says "set it per tool below". */
  control:
    | { kind: "locked" }
    | { kind: "mixed" }
    | { kind: "box"; checked: boolean; disabled: boolean };
  /** The editable tools this row is a control FOR — the save's `drawn` tools. */
  drawn: string[];
  /** The per-tool rows, drawn only when the row is expanded. */
  tools: { tool: string; writeOnly: boolean; checked: boolean }[];
};

type MaskSection = {
  dir: Direction;
  title: string;
  note: string;
  count: number;
  rows: MaskRow[];
  /** Rendered in place of the rows when there are none. */
  state: string | null;
  /** The tools declaring no output schema, where that is worth saying. */
  noSchema: string | null;
};

/**
 * One direction's rows, built from the path index and the DRAFT's mask set.
 *
 * The three control shapes are the server's, for its reasons: a path masked on some but not
 * all of its editable tools renders expanded and offers no path box, so no save can flatten a
 * partial state into all-or-nothing; a path every tool declares `writeOnly` still has a
 * control, disabled, because "there is no control" says something different from "the control
 * cannot be moved".
 */
function sectionOf({
  dir,
  index,
  marks,
  view,
  q,
  open,
}: {
  dir: Direction;
  index: Map<string, PathEntry>;
  marks: ReadonlySet<string>;
  view: FamilyView;
  /** Already lowercased — the filter matches a path case-insensitively. */
  q: string;
  open: readonly string[];
}): MaskSection {
  const rows: MaskRow[] = [...index.entries()]
    .filter(([path]) => q === "" || path.toLowerCase().includes(q))
    .sort((left, right) => right[1].tools.length - left[1].tools.length || left[0].localeCompare(right[0]))
    .map(([path, entry]) => {
      const editable = entry.tools.filter((tool) => !tool.writeOnly);
      const locked = entry.tools.filter((tool) => tool.writeOnly);
      const on = editable.filter((tool) => marks.has(`${tool.tool}.${path}`)).length;
      const all = editable.length > 0 && on === editable.length;
      const mixed = on > 0 && !all;
      const expanded = open.includes(`${dir}:${path}`) || mixed;
      const status =
        locked.length > 0
          ? `declared writeOnly${locked.length < entry.tools.length ? ` on ${locked.length}` : ""}`
          : on === 0
            ? ""
            : `masked on ${all ? (editable.length === 1 ? "its tool" : `all ${editable.length}`) : `${on} of ${editable.length}`}`;
      return {
        path,
        type: entry.type,
        detail: `${plural(entry.tools.length, "tool")}${status === "" ? "" : ` · ${status}`}`,
        expandable: entry.tools.length > 1 || locked.length > 0,
        expanded,
        control:
          editable.length === 0
            ? { kind: "locked" as const }
            : mixed
              ? { kind: "mixed" as const }
              : { kind: "box" as const, checked: all, disabled: expanded },
        drawn: editable.map((tool) => tool.tool),
        tools: expanded
          ? entry.tools.map((tool) => ({
              tool: tool.tool,
              writeOnly: tool.writeOnly,
              checked: tool.writeOnly || marks.has(`${tool.tool}.${path}`),
            }))
          : [],
      };
    });

  const noOutput =
    dir === "results" && q === ""
      ? itemsOf(view)
          .filter((item) => item.outputSchema === undefined)
          .map((item) => item.name ?? "")
      : [];
  return {
    dir,
    title: dir === "args" ? "Arguments" : "Results",
    note: dir === "args" ? "from each tool's inputSchema" : "from outputSchema, where declared",
    count: rows.length,
    rows,
    state: rows.length === 0 ? (q === "" ? "no schema declares any field" : "no path matches") : null,
    noSchema:
      noOutput.length === 0
        ? null
        : `${noOutput.length > 3 ? plural(noOutput.length, "tool") : noOutput.join(", ")} declare no output schema — a result path there can only come from a recorded call (mask from evidence).`,
  };
}

/**
 * One section's body as the wire takes it. `wholePath` admits a row only where its control is
 * a live box that is ticked: the `locked` and `mixed` shapes submit nothing, and an expanded
 * row's box is disabled because its per-tool rows are the statement.
 */
function bodyOf(section: MaskSection): RedactionDraft {
  const wholePath: string[] = [];
  const perTool: string[] = [];
  for (const row of section.rows) {
    if (row.control.kind === "box" && !row.control.disabled && row.control.checked) wholePath.push(row.path);
    for (const tool of row.tools) {
      if (!tool.writeOnly && tool.checked) perTool.push(`${tool.tool}.${row.path}`);
    }
  }
  return { drawn: section.rows.map((row) => [row.path, row.drawn]), wholePath, perTool };
}

function Section({
  section,
  q,
  open,
  onTool,
  onPath,
}: {
  section: MaskSection;
  q: string;
  open: readonly string[];
  /** One `"<tool>.<path>"` pair moved. */
  onTool: (pair: string, on: boolean) => void;
  /** Every editable pair of one path moved together. */
  onPath: (pairs: string[], on: boolean) => void;
}): ReactNode {
  return (
    <>
      <GroupHead sticky>
        <span>
          {section.title} · {section.count} path{section.count === 1 ? "" : "s"}
        </span>
        <GroupHeadNote render={<span />}>{section.note}</GroupHeadNote>
      </GroupHead>
      {section.state === null ? (
        section.rows.map((row) => (
          <div key={row.path}>
            <ListRow>
              <div>
                <span className="font-mono">{row.path}</span> <ListRowType>{row.type}</ListRowType>
                <ListRowDetail>
                  {row.detail}
                  {row.expandable ? (
                    <>
                      {" "}
                      <Link to="." search={whichSearch(section.dir, row.path, open, q)}>
                        {row.expanded ? "hide" : "which"}
                      </Link>
                    </>
                  ) : null}
                </ListRowDetail>
              </div>
              <ListRowControl>
                {row.control.kind === "locked" ? (
                  // A CONTROL, disabled — the path has one, it is ticked, and it is not the
                  // owner's to clear. Disabled, so it contributes nothing to `wholePath`.
                  <Checkbox
                    variant="tick"
                    lock
                    checked
                    disabled
                    aria-label={`mask ${row.path}`}
                    title="declared writeOnly by the app — always masked"
                  />
                ) : row.control.kind === "mixed" ? (
                  <Tick state="mixed" title="masked on some of its tools — set it per tool below" />
                ) : (
                  <Checkbox
                    variant="tick"
                    checked={row.control.checked}
                    disabled={row.control.disabled}
                    aria-label={`mask ${row.path}`}
                    title={row.control.disabled ? "set it per tool below" : "mask on every tool that takes it"}
                    onCheckedChange={(checked) =>
                      onPath(
                        row.drawn.map((tool) => `${tool}.${row.path}`),
                        checked,
                      )
                    }
                  />
                )}
              </ListRowControl>
            </ListRow>
            {row.tools.map((tool) => (
              <ListRow sub key={`${row.path}\u0000${tool.tool}`}>
                <div>
                  <span className="font-mono">{tool.tool}</span>
                  {tool.writeOnly ? <ListRowDetail>declared by the app — always masked</ListRowDetail> : null}
                </div>
                <ListRowControl>
                  {tool.writeOnly ? (
                    <Tick state="lock" />
                  ) : (
                    <Checkbox
                      variant="tick"
                      checked={tool.checked}
                      aria-label={`mask ${row.path} on ${tool.tool}`}
                      onCheckedChange={(checked) => onTool(`${tool.tool}.${row.path}`, checked)}
                    />
                  )}
                </ListRowControl>
              </ListRow>
            ))}
          </div>
        ))
      ) : (
        <ListingNote>{section.state}</ListingNote>
      )}
      {section.noSchema === null ? null : (
        <ListingNote>{section.noSchema}</ListingNote>
      )}
    </>
  );
}

/** One direction's `Arguments · N masked` card: every masked path, and who masks it — read
 *  from the STORED map and the app's own declaration, never from the draft. */
function MaskedCard({
  dir,
  stored,
  index,
}: {
  dir: Direction;
  stored: Record<string, string[]>;
  index: Map<string, PathEntry>;
}): ReactNode {
  const byPath = new Map<string, { config: string[]; declared: string[] }>();
  const at = (path: string): { config: string[]; declared: string[] } => {
    const found = byPath.get(path) ?? { config: [], declared: [] };
    byPath.set(path, found);
    return found;
  };
  for (const [tool, paths] of Object.entries(stored)) {
    for (const path of paths) at(path).config.push(tool);
  }
  for (const [path, entry] of index) {
    for (const tool of entry.tools) if (tool.writeOnly) at(path).declared.push(tool.tool);
  }
  const rows = [...byPath.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([path, who]) => ({
      path,
      detail: [
        who.config.length === 0 ? "" : `on ${names(who.config)}`,
        who.declared.length === 0 ? "" : `declared writeOnly by ${names(who.declared)}`,
      ]
        .filter((part) => part !== "")
        .join(" · "),
    }));
  return (
    <Card size="sm" render={<section />}>
      <Eyebrow>
        {dir === "args" ? "Arguments" : "Results"} · {rows.length} masked
      </Eyebrow>
      {rows.length === 0 ? (
        <Note>
          nothing masked — {dir === "args" ? "arguments" : "results"} are recorded whole
        </Note>
      ) : (
        // A path is long and who masks it is longer: the two stack rather than sitting either
        // side of a narrow key column.
        rows.map((row) => (
          <div key={row.path}>
            <span className="font-mono">{row.path}</span>
            <ListRowDetail>{row.detail}</ListRowDetail>
          </div>
        ))
      )}
    </Card>
  );
}

/* ------------------------------------------------------------ the derivations --- */

/**
 * One direction's paths, indexed over every tool's schema. The order is the listing's, and the
 * `type` is the first declaration's: two tools may declare the same path, and the table says
 * how many take it rather than asserting they agree about its type.
 */
function pathIndexOf(view: FamilyView, dir: Direction): Map<string, PathEntry> {
  const index = new Map<string, PathEntry>();
  const items = itemsOf(view);
  const derived = derivedOf(view);
  for (let position = 0; position < items.length; position += 1) {
    const tool = items[position].name ?? "";
    const leaves = dir === "args" ? derived[position]?.argPaths : derived[position]?.resultPaths;
    for (const leaf of leaves ?? []) {
      const entry = index.get(leaf.path) ?? { type: leaf.type, tools: [] };
      entry.tools.push({ tool, writeOnly: leaf.writeOnly });
      index.set(leaf.path, entry);
    }
  }
  return index;
}

/** A stored redaction map as the draft holds it: one `"<tool>.<path>"` per masked pair. The
 *  key is always composed from the pair and never parsed back, so a tool name carrying a dot
 *  cannot be misread — the same property the form's `m.<dir>.<tool>.<path>` field had. */
function markSet(stored: Record<string, string[]>): Set<string> {
  const marks = new Set<string>();
  for (const [tool, paths] of Object.entries(stored)) {
    for (const path of paths) marks.add(`${tool}.${path}`);
  }
  return marks;
}

/** This pane's URL with one more (or one fewer) `which=` on it, so several paths can be open
 *  at once and the expanded set is addressable. The filter rides along: opening a path is a
 *  reading step, and losing the filter that found it sends the owner back through the list. */
function whichSearch(
  dir: Direction,
  path: string,
  open: readonly string[],
  q: string,
): Record<string, string | string[]> {
  const key = `${dir}:${path}`;
  const kept = open.filter((each) => each !== key);
  const which = open.includes(key) ? kept : [...kept, key];
  return { ...(q === "" ? {} : { q }), ...(which.length === 0 ? {} : { which }) };
}

/** A list of tool names, or their count past three — the card's own abbreviation. */
function names(tools: string[]): string {
  const sorted = [...new Set(tools)].sort();
  return sorted.length > 3 ? plural(sorted.length, "tool") : sorted.join(", ");
}
