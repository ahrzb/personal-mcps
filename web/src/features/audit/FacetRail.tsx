import type { ReactNode } from "react";
import { FACET_TOP, fmtCount } from "./derive";
import type { FacetField, FacetGroup, Filter } from "./derive";
import { SkelBar, Swatch } from "./parts";
import type { OutcomeClass } from "./derive";

/**
 * The facet rail: every value the loaded rows hold, with how many rows it would leave.
 *
 * Each count is computed under every OTHER group's filters but not its own (§3, Hearst's
 * exhaustive counts) — which is what makes a group widenable: if ticking `denied` zeroed
 * `ok`'s count, the reader could never see that ok rows existed to add back.
 *
 * Several values in one group OR; groups AND. `session` is never a group here — it is set from
 * a record, because a namespace has more session ids than anyone browses.
 *
 * ONE component for two places: the wide rail and, at narrow, the body of the full-screen
 * Filters level, which names itself in its own header and therefore drops the title.
 */
export function FacetRail({
  groups,
  /** Rows the current selection keeps, and rows the window holds — the rail's own first line. */
  selected,
  inWindow,
  /** Which groups are expanded past their top few, by field. */
  expanded,
  onToggleValue,
  onToggleGroup,
  titled = true,
}: {
  groups: FacetGroup[];
  selected: number;
  inWindow: number;
  expanded: Partial<Record<FacetField, boolean>>;
  onToggleValue: (filter: Filter) => void;
  onToggleGroup: (field: FacetField) => void;
  titled?: boolean;
}): ReactNode {
  return (
    <>
      {titled ? <h3 className="a-rail-title">Filter</h3> : null}
      <p className="note a-railnote">
        {fmtCount(selected)} of {fmtCount(inWindow)} in window
      </p>
      {groups.map((group) => {
        const cap = FACET_TOP[group.field];
        const open = expanded[group.field] === true;
        const shown = open ? group.values : group.values.slice(0, cap);
        return (
          <div className="a-fgroup" key={group.field}>
            <p className="eyebrow">{group.field}</p>
            {shown.map((value) => (
              <button
                key={value.value}
                type="button"
                className="a-frow"
                // A toggle, so it says so: the row is pressed or it is not, and a reader who
                // cannot see the fill still knows which values are on.
                aria-pressed={value.on}
                title={value.value}
                onClick={() => onToggleValue({ field: group.field, value: value.value })}
              >
                <span className="a-bar" style={{ width: `${(value.count / group.max) * 100}%` }} />
                {group.field === "outcome" ? <Swatch cls={value.value as OutcomeClass} /> : null}
                <span className="a-nm">{value.value}</span>
                <span className="a-ct">{fmtCount(value.count)}</span>
              </button>
            ))}
            {group.total > cap ? (
              <button type="button" className="a-showall" onClick={() => onToggleGroup(group.field)}>
                {open ? `Show top ${cap}` : `Show all ${fmtCount(group.total)}`}
              </button>
            ) : null}
          </div>
        );
      })}
      <div className="a-fgroup">
        <p className="eyebrow">session</p>
        <p className="note a-railnote">Opened from a record, never listed — too many to browse.</p>
      </div>
    </>
  );
}

/** The rail while the window loads. Twelve bars of two widths: a rail of identical bars reads
 *  as a table, and what is coming is a list of names. */
export function FacetRailSkeleton(): ReactNode {
  return (
    <>
      <h3 className="a-rail-title">Filter</h3>
      {Array.from({ length: 12 }, (_, index) => (
        <div className="a-frow" key={index}>
          <SkelBar width={index % 3 === 0 ? "70%" : "90%"} />
        </div>
      ))}
    </>
  );
}
