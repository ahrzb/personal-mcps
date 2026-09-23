import type { ReactNode } from "react";
import { FACET_TOP, fmtCount } from "./derive";
import type { FacetField, FacetGroup, Filter } from "./derive";
import { EYEBROW, FROW, NOTE, SkelBar, Swatch } from "./parts";
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
  /** The wide rail (titled) rather than the Filters level. Each lays its groups out its own way
   *  below 1024px, so this also picks those classes. */
  titled?: boolean;
}): ReactNode {
  const group = titled ? RAIL_GROUP : "mt-2.5";
  return (
    <>
      {titled ? <h3 className={RAIL_TITLE}>Filter</h3> : null}
      {/* At the regular tier the rail is a wrapping row of groups, and this line takes a whole
          row of it, as the title does. */}
      <p className={titled ? `${NOTE} px-[5px] md:max-lg:w-full` : `${NOTE} px-[5px]`}>
        {fmtCount(selected)} of {fmtCount(inWindow)} in window
      </p>
      {groups.map((facet) => {
        const cap = FACET_TOP[facet.field];
        const open = expanded[facet.field] === true;
        const shown = open ? facet.values : facet.values.slice(0, cap);
        return (
          <div className={group} key={facet.field}>
            <p className={GROUP_LABEL}>{facet.field}</p>
            {shown.map((value) => (
              <button
                key={value.value}
                type="button"
                className={titled ? `${FROW} h-control-xs` : `${FROW} h-control-xs ${LEVEL_ROW}`}
                // A toggle, so it says so: the row is pressed or it is not, and a reader who
                // cannot see the fill still knows which values are on.
                aria-pressed={value.on}
                title={value.value}
                onClick={() => onToggleValue({ field: facet.field, value: value.value })}
              >
                <span
                  className="absolute inset-y-0.5 left-0 rounded-[4px] bg-a-bar"
                  style={{ width: `${(value.count / facet.max) * 100}%` }}
                />
                {facet.field === "outcome" ? <Swatch cls={value.value as OutcomeClass} className="relative" /> : null}
                <span className="relative truncate font-mono">{value.value}</span>
                <span className="relative ml-auto pl-1.5 text-2xs text-muted-foreground">{fmtCount(value.count)}</span>
              </button>
            ))}
            {facet.total > cap ? (
              <button
                type="button"
                className={titled ? SHOW_ALL : `${SHOW_ALL} max-md:h-control-touch max-md:text-xs`}
                onClick={() => onToggleGroup(facet.field)}
              >
                {open ? `Show top ${cap}` : `Show all ${fmtCount(facet.total)}`}
              </button>
            ) : null}
          </div>
        );
      })}
      <div className={group}>
        <p className={GROUP_LABEL}>session</p>
        <p className={`${NOTE} px-[5px]`}>Opened from a record, never listed — too many to browse.</p>
      </div>
    </>
  );
}

/** The rail while the window loads. Twelve bars of two widths: a rail of identical bars reads
 *  as a table, and what is coming is a list of names. */
export function FacetRailSkeleton(): ReactNode {
  return (
    <>
      <h3 className={RAIL_TITLE}>Filter</h3>
      {Array.from({ length: 12 }, (_, index) => (
        <div className={`${FROW} h-control-xs`} key={index}>
          <SkelBar width={index % 3 === 0 ? "70%" : "90%"} />
        </div>
      ))}
    </>
  );
}

/** The rail's title, 12px and level with the rows' text; a whole row at the regular tier. */
const RAIL_TITLE = "mb-0.5 px-[5px] text-xs font-semibold md:max-lg:w-full";

/** A group in the wide rail. At the regular tier the rail's groups wrap side by side, 180px
 *  each at least; the Filters level stacks them at every width. */
const RAIL_GROUP = "mt-2.5 md:max-lg:min-w-[180px] md:max-lg:flex-[1_1_180px]";

const GROUP_LABEL = `${EYEBROW} mb-[3px] px-[5px]`;

/** A row of the phone's Filters level: the touch height, and 13px text to go with it. */
const LEVEL_ROW = "max-md:h-control-touch max-md:text-sm";

/** Widens a group past its top few, or folds it back. */
const SHOW_ALL =
  "h-control-xs w-full cursor-pointer rounded-[5px] border-0 bg-transparent px-[5px] py-0 text-left font-[family-name:inherit] text-2xs text-muted-foreground underline underline-offset-2 hover:text-foreground";
