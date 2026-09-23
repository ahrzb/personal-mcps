import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Bench } from "./Bench";

/**
 * The InputGroup bench: /audit's search box, `<InputGroup size="sm">` with the filter bar's
 * call-site classes, as the bar holds it (44px at the narrow breakpoint).
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
    <Bench>
      <Next />
      <Next value="linear.create_issue" />
      <Next value="linear.create_issue" busy />
    </Bench>
  ),
  // `data-focus`: visual-compare focuses the target just before the shot. The `p-1` frame
  // keeps the box's 3px ring inside the crop.
  "input-group-focus": () => (
    <Bench>
      <div className="w-full p-1">
        <Next value="linear" focus />
      </div>
    </Bench>
  ),
};
