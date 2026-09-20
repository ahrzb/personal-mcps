/**
 * The (agent × app) grant editor's rows, groups and controls, and the view-model types they
 * are drawn from — a port of `server/src/pages/grant-rows.tsx`, unchanged in what it draws.
 *
 * ONE definition, rendered by BOTH pages that edit a grant set: `/agents/<slug>/apps/<app>`
 * (and the agent page's landing, which renders that pane in place) and
 * `/apps/<slug>/access` with an agent selected. §6 makes the second the first "verbatim",
 * and verbatim has to mean the same component over the same groups — two copies would be
 * two editors that drift. The groups come from `grant-editor.ts`'s one builder, so both
 * pages' listings are the same rows in the same order for the same reason.
 *
 * ONE mechanical change from the server's rows, and it is the whole point of the rewrite:
 * there is no form. A row's three-way control writes the caller's DRAFT — the pair's whole
 * entry set, held as UI state — and Save PUTs that set. The server's hidden `carry` fields
 * and its `drop`/`add`/`mode` submit buttons existed to reconstruct the whole set from one
 * submission; the draft already is the whole set, so a filtered listing cannot drop an entry
 * it never drew and nothing needs carrying.
 *
 * Pure: props in, JSX out. No query, no router, no clock.
 */

import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

/** What one entry's control can say. `none` contributes NOTHING to the saved set — that is
 *  how this editor revokes, since the op replaces the pair's whole set. */
export type GrantChoice = "allow" | "approval" | "none";

/**
 * One row's three-way control, as both the listing and the details pane draw it. `value` is
 * the DIRECT entry's mode and is what the row writes; `implied` is what the rest of the set
 * already grants on this subject, drawn hollow and written by nothing — so a row can show
 * `allow` reached through a role while holding no entry of its own.
 */
export type RowControl = {
  /** The entry string the control writes, spelled exactly as it is stored — the draft's own
   *  key, and what `grantChoicesOf` read off `e.<entry>` on the server. */
  entry: string;
  value: GrantChoice;
  /** The mode the OTHER entries grant here, or null when they grant nothing. */
  implied: "allow" | "approval" | null;
  /** Which entries grant it — the names the disabled buttons' `title` reads. */
  impliedBy: string[];
};

/**
 * One line of description a row draws.
 *
 * `html` is the hub's OWN rendering of the app's untrusted prose — `pages/markdown.ts`'s
 * `inlineMarkdown` output, which arrives on the wire because that module is the only thing
 * allowed to turn app text into markup and it does not run in the browser. It is the one
 * string in this client handed to `dangerouslySetInnerHTML`, and it is safe there for the
 * reason the renderer exists: its whitelist escapes raw HTML, drops `id`/`class`/`style`,
 * allows no scheme but http/https/mailto and emits no images.
 *
 * `html: null` is a line that is not prose and was never rendered as any — a resource's media
 * type. It is drawn as a text child, never as markup.
 *
 * `text` is the un-marked-up form, and is what the filter matches on: a search for `all` must
 * find a description that writes it `**all**`.
 */
export type RowProse = { html: string | null; text: string };

/** One listing row. The four kinds differ in what they say, not in what they do: every one
 *  of them names an entry the set may hold. */
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
      description: RowProse;
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
 * One listing group: a heading with its count and, where the family could not be listed, the
 * ONE note line that stands in for its rows (§13's `unconnected` / `undeclared` / `unread`,
 * said in the words the app page says them in).
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

/** What every row of this editor does when it is used: write one entry's mode into the
 *  caller's draft. The `×` writes `none`, which is the same act said in one word. */
export type ChooseEntry = (entry: string, choice: GrantChoice) => void;

/* ------------------------------------------------------------ the control --- */

/** The three buttons, in the order the boards fix them, with the mode each writes. */
const SEGMENTS: { value: GrantChoice; label: string; rank: number }[] = [
  { value: "none", label: "none", rank: 0 },
  { value: "approval", label: "ask", rank: 1 },
  { value: "allow", label: "allow", rank: 2 },
];

const RANK: Record<GrantChoice, number> = { none: 0, approval: 1, allow: 2 };

/**
 * One row's three-way control: three radios in a `.seg`, the checked one being the DIRECT
 * entry's mode. Where the rest of the set already grants more than this row does, the
 * implied button is drawn hollow and everything below it is disabled — lowering it means
 * lowering the entry that grants it, which is what the disabled button's title says.
 *
 * One exception to "below the implied mode is disabled": the segment that is checked AND
 * carries an entry. The direct ask under an allowing role is the row the `ask entry · no
 * effect` badge exists to keep, and a control that could not be read at its own value would
 * be a row the owner cannot see the state of.
 */
export function Seg({ control, onChoose }: { control: RowControl; onChoose: ChooseEntry }): ReactNode {
  const impliedRank = control.implied === null ? -1 : RANK[control.implied];
  const title = `${control.impliedBy.join(", ")} grants ${control.implied === "allow" ? "allow" : "ask"} — change the role to lower it`;
  return (
    <span className="seg">
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
            key={segment.value}
            className={`seg-opt${implied ? " impl" : ""}${warn ? " seg-opt--warn" : ""}`}
            title={disabled ? title : undefined}
          >
            {/* The title sits on the input as well: a pointer reaches the label, a keyboard
                reaches the input, and both are owed the reason. */}
            <input
              type="radio"
              name={`e.${control.entry}`}
              value={segment.value}
              checked={checked}
              disabled={disabled}
              title={disabled ? title : undefined}
              onChange={() => onChoose(control.entry, segment.value)}
            />
            <span>{segment.label}</span>
          </label>
        );
      })}
    </span>
  );
}

/** The `×` beside a badge: the one control that removes an entry the three-way control does
 *  not draw — a held role the app no longer declares, and the direct ask under an allow. */
export function DropButton({ entry, onChoose }: { entry: string; onChoose: ChooseEntry }): ReactNode {
  return (
    <button
      type="button"
      className="badge-x"
      title="remove this entry"
      onClick={() => onChoose(entry, "none")}
    >
      ×
    </button>
  );
}

/* ---------------------------------------------------------- rows · groups --- */

/**
 * Where a row's `sel` goes on the page that drew it — the only thing the two pages that
 * render this editor differ in. Split into a path and a search bag rather than one string
 * because that is what a client-side `Link` takes: a `?sel=` appended to `to` would be part
 * of the pathname and would match no route.
 */
export type RowLink = (sel: string) => { to: string; search: Record<string, string> };

/** One listing row of the grant editor. */
export function GrantRow({
  row,
  link,
  onChoose,
}: {
  row: AgentListRow;
  link: RowLink;
  onChoose: ChooseEntry;
}): ReactNode {
  if (row.kind === "undeclared") {
    return (
      <div className="cr">
        <div>
          <span className="mono">{row.entry}</span> <span className="badge badge--warning">undeclared</span>
          <div className="cr-detail">granted, but the app has not declared it — dormant</div>
        </div>
        <div className="cr-control">
          {/* No three-way control here: the entry names nothing the app declares, so there
              is nothing to raise or lower — the × is the only thing to do with it. The
              server drew a hidden field beside it to keep the entry across a submit; the
              draft keeps it instead. */}
          <span className={row.standing === "allow" ? "badge badge--success" : "badge badge--warning"}>
            {row.standing === "allow" ? "in Allowed" : "in Ask first"}
            <DropButton entry={row.entry} onChoose={onChoose} />
          </span>
        </div>
      </div>
    );
  }
  if (row.kind === "role") {
    return (
      <div className="cr">
        <div>
          <Link className="row-link mono" {...link(row.sel)}>
            {row.entry}
          </Link>
          {row.builtin ? (
            <>
              {" "}
              <span className="badge badge--muted">built-in</span>
            </>
          ) : null}
          <div className="cr-detail">{row.detail}</div>
        </div>
        <div className="cr-control">
          <Seg control={row.control} onChoose={onChoose} />
        </div>
      </div>
    );
  }
  if (row.kind === "pattern") {
    return (
      <div className="cr">
        <div>
          <Link className="row-link mono" {...link(row.sel)}>
            {row.entry}
          </Link>
          <div className={row.dormant ? "cr-detail cr-detail--warn" : "cr-detail"}>{row.detail}</div>
        </div>
        <div className="cr-control">
          <Seg control={row.control} onChoose={onChoose} />
        </div>
      </div>
    );
  }
  return (
    <div className="cr">
      <div>
        <Link className="row-link mono" {...link(row.sel)}>
          {row.name}
        </Link>
        {/* The app's own prose, rendered by the hub and inline only: a row is one line high,
            and a fence or a list in a description must not be allowed to make it three. The
            markup is `pages/markdown.ts`'s output — the one renderer allowed to produce it —
            which is why this is the one `dangerouslySetInnerHTML` in the listing; a media
            type, which is not prose, is drawn as a child instead. */}
        {row.description.html === null ? (
          <div className="cr-detail md">{row.description.text}</div>
        ) : (
          <div className="cr-detail md" dangerouslySetInnerHTML={{ __html: row.description.html }} />
        )}
      </div>
      <div className="cr-control">
        {row.noEffect ? (
          <span className="badge badge--warning" title="allow wins over ask">
            ask entry · no effect
            <DropButton entry={row.entry} onChoose={onChoose} />
          </span>
        ) : null}
        {row.via.length === 0 ? null : (
          <span className="via">
            {row.alsoVia ? "also via" : "via"} {row.via.join(", ")}
          </span>
        )}
        <Seg control={row.control} onChoose={onChoose} />
      </div>
    </div>
  );
}

export function GrantGroup({
  group,
  link,
  onChoose,
}: {
  group: AgentListGroup;
  link: RowLink;
  onChoose: ChooseEntry;
}): ReactNode {
  return (
    <>
      {group.title === "" ? null : (
        <div className="gh">
          <span>
            {group.title}
            {group.count === "" ? null : ` · ${group.count}`}
          </span>
          {group.note === "" ? null : <span className="gh-note">{group.note}</span>}
        </div>
      )}
      {group.state === null
        ? group.rows.map((row) => <GrantRow key={row.entry} row={row} link={link} onChoose={onChoose} />)
        : <p className="note gh-state">{group.state}</p>}
    </>
  );
}

/** `<agent> reaches N of T tools · K ask first · P of PT prompts · R of RT resources`. */
export function reachLine(
  agent: string,
  reach: { tools: FamilyReach; prompts: FamilyReach; resources: FamilyReach },
): string {
  return `${agent} reaches ${reach.tools.reached} of ${reach.tools.total} tools · ${reach.tools.approval} ask first · ${reach.prompts.reached} of ${reach.prompts.total} prompts · ${reach.resources.reached} of ${reach.resources.total} resources`;
}
