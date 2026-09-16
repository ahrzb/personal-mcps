// grant-rows.tsx — the (agent × app) grant editor's rows, groups and controls, and the
// view-model types they are drawn from. ONE definition, rendered by BOTH pages that edit a
// grant set: `/agents/<slug>` (the app pane) and `/apps/<slug>/access` (an agent selected).
//
// Extracted from agent-detail.tsx on 2026-09-17, unchanged in what it draws: the app page's
// Agents pane is §6's "the agent page's grant editor, verbatim", and verbatim has to mean
// the same component over the same groups — two copies would be two editors that drift,
// and the field names (`e.<entry>`, `drop`, `add`, `mode`) are a contract the two POST
// routes read back through model's own `grantChoicesOf`.
//
// Pure: (props) => JSX. The groups are built by model.ts's one builder (`grantEditorOf`),
// so both pages' listings are the same rows in the same order for the same reason.

import type { FC } from "hono/jsx";
import { entryField } from "./model";
import type { GrantChoice } from "./model";
import { inlineMarkdown } from "./markdown";
import { raw } from "hono/html";

/**
 * One row's radio group, as both the listing and the details pane draw it. `value` is the
 * DIRECT entry's mode and is what the row submits; `implied` is what the rest of the set
 * already grants on this subject, drawn hollow and never submitted — so a row can show
 * `allow` reached through a role while submitting nothing of its own.
 */
export type RowControl = {
  /** The field name — `e.<entry>`, spelled by `entryField` and read back by
   *  `grantChoicesOf`, the two halves of the one translation this form makes. */
  field: string;
  value: GrantChoice;
  /** The mode the OTHER entries grant here, or null when they grant nothing. */
  implied: "allow" | "approval" | null;
  /** Which entries grant it — the names the disabled buttons' `title` reads. */
  impliedBy: string[];
};

/** One listing row. The four kinds differ in what they say, not in what they do: every
 *  one of them names an entry the set may hold. */
export type AgentListRow =
  | {
      kind: "role";
      /** The entry string — a role name, so never containing `/`. */
      entry: string;
      builtin: boolean;
      /** `<family> <patterns> · matches N`, or the built-in's own sentence. */
      detail: string;
      /** `?sel=` for this row's details. */
      sel: string;
      control: RowControl;
    }
  | {
      kind: "undeclared";
      entry: string;
      /** Which side the entry sits on — the `in Allowed` / `in Ask first` badge. */
      standing: "allow" | "approval";
    }
  | {
      kind: "item";
      /** `tool/<name>` · `prompt/<name>` · `resource/<uri>` — the DIRECT entry. */
      entry: string;
      /** The subject itself: a tool or prompt name, or a resource URI. */
      name: string;
      description: string;
      /** The entries that reach it besides the direct one, for the `via` line. */
      via: string[];
      /** `also via` rather than `via`: the row also carries a direct entry. */
      alsoVia: boolean;
      /** A direct ask under something that allows — kept, badged, removable. */
      noEffect: boolean;
      sel: string;
      control: RowControl;
    }
  | {
      kind: "pattern";
      entry: string;
      /** `matches N today` / `matches nothing today`. */
      detail: string;
      /** True for the second of those, which the board draws amber. */
      dormant: boolean;
      sel: string;
      control: RowControl;
    };

/**
 * One listing group: a heading with its count and, where the family could not be listed,
 * the ONE note line that stands in for its rows (§13's `unconnected` / `undeclared` /
 * `unread`, said in the words the app page says them in).
 */
export type AgentListGroup = {
  title: string;
  /** Empty where the heading carries no count (the pattern offer's `As a pattern`). */
  count: string;
  /** The heading's right-hand note (`declared by the app at connect`, `8 reached · 3 not`). */
  note: string;
  /** Rendered in place of `rows` when the family could not be listed; null otherwise. */
  state: string | null;
  rows: AgentListRow[];
};

/** The typed text offered as a pattern entry, when it is not one item's name. */
export type AgentPatternOffer = {
  /** `tool/<q>`, or `resource/<q>` when the text carries a URI scheme. */
  entry: string;
  /** `would match N today, and any added later` / `matches nothing today`. */
  detail: string;
};

/** How far the agent reaches into one §20 family, as the listing's reach line reads it. */
export type FamilyReach = {
  reached: number;
  total: number;
  /** Subjects reached in approval mode — the `K ask first` the tools half prints. */
  approval: number;
};

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
export const Seg: FC<{ control: RowControl }> = ({ control }) => {
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

/** The `×` beside a badge: a submit button naming the entry to drop, so it works with
 *  scripting off and rides the same Save the radios do. */
export const DropButton: FC<{ entry: string }> = ({ entry }) => (
  <button type="submit" class="badge-x" name="drop" value={entry} title="remove this entry">
    ×
  </button>
);

/* ---------------------------------------------------------- rows · groups --- */

/** One listing row of the grant editor. `href` turns a row's `sel` into this page's own
 *  URL — the only thing the two pages that render this differ in. */
export const GrantRow: FC<{ row: AgentListRow; href: (sel: string) => string }> = ({ row, href }) => {
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

export const GrantGroup: FC<{ group: AgentListGroup; href: (sel: string) => string }> = ({ group, href }) => (
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
    {group.state === null ? (
      group.rows.map((row) => <GrantRow row={row} href={href} />)
    ) : (
      <p class="note gh-state">{group.state}</p>
    )}
  </>
);

/** `<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources`. */
export function reachLine(
  agent: string,
  reach: { tools: FamilyReach; prompts: FamilyReach; resources: FamilyReach },
): string {
  return `${agent} reaches ${reach.tools.reached} of ${reach.tools.total} tools · ${reach.tools.approval} ask first · ${reach.prompts.reached} of ${reach.prompts.total} prompts · ${reach.resources.reached} of ${reach.resources.total} resources`;
}
