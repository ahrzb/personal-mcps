import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Columns } from "./Columns";

/**
 * The InputGroup bench: /audit's search box, `.a-search`, as its filter bar holds it
 * (`.a-fbar`, where it is 44px at the narrow breakpoint), beside `<InputGroup size="sm">`
 * with the filter bar's call-site classes.
 */

/** audit's SearchIcon. */
function SearchIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

const PLACEHOLDER = "Search events and bodies…  ( / )";

/** The filter bar's own classes for the box: 260px wide at least, and a flexible touch-sized field at narrow. */
const FBAR = "min-w-[260px] max-md:h-control-touch max-md:min-w-0 max-md:flex-[1_1_120px]";

function Legacy({ value, busy, focus }: { value?: string; busy?: boolean; focus?: boolean }): ReactNode {
  return (
    <div className="a-fbar w-full">
      <div className="a-search">
        <SearchIcon />
        <input defaultValue={value} placeholder={PLACEHOLDER} aria-label="Search events and bodies" data-focus={focus} />
        {busy ? (
          <span className="note a-searching" role="status">
            Searching…
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Next({ value, busy, focus }: { value?: string; busy?: boolean; focus?: boolean }): ReactNode {
  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <InputGroup size="sm" className={FBAR}>
        <InputGroupAddon>
          <SearchIcon />
        </InputGroupAddon>
        <InputGroupInput defaultValue={value} placeholder={PLACEHOLDER} aria-label="Search events and bodies" data-focus={focus} />
        {busy ? (
          <InputGroupAddon className="text-xs text-muted-foreground" role="status">
            Searching…
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}

export const inputGroupStates: Record<string, PrimitiveState> = {
  // Empty (the placeholder), holding a query, and holding one while its read is in flight.
  "input-group": () => (
    <Columns
      legacy={
        <>
          <Legacy />
          <Legacy value="linear.create_issue" />
          <Legacy value="linear.create_issue" busy />
        </>
      }
      next={
        <>
          <Next />
          <Next value="linear.create_issue" />
          <Next value="linear.create_issue" busy />
        </>
      }
    />
  ),
  // `data-focus`: visual-compare focuses each column's target just before shooting it. The
  // `p-1` frame would keep a ring inside the cropped column. Today's box draws none, and this
  // state is the proof.
  "input-group-focus": () => (
    <Columns
      legacy={
        <div className="w-full p-1">
          <Legacy value="linear" focus />
        </div>
      }
      next={
        <div className="w-full p-1">
          <Next value="linear" focus />
        </div>
      }
    />
  ),
};
