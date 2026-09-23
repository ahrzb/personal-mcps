import type { ReactNode } from "react";

/**
 * The frame every `primitives` state draws: one component, in the cell
 * `scripts/visual-compare.mts` crops (`[data-bench]`) and diffs against the state's baseline,
 * `design/baseline/primitives__<state>__<viewport>.png`, at a budget of 0.
 *
 * The frame's geometry is the baselines' contract: a two-column grid whose left column is
 * empty. The baselines were cut from pass 2's first bench, which drew the legacy markup in that
 * column and the component in this cell until legacy.css was deleted (P5). Chromium's
 * antialiasing of a rounded corner or a glyph edge shifts by a colour step or two when the same
 * box is painted elsewhere on the page, even a whole pixel away, so a cell moved to the left
 * edge redraws most crops a shade off. Change the grid, the caption or the gaps, and every
 * baseline is to be re-cut.
 */
export function Bench({ children }: { children: ReactNode }): ReactNode {
  return (
    <main className="grid grid-cols-2 gap-x-4 gap-y-2 p-4">
      <div />
      <p className="text-sm text-muted-foreground">component</p>
      <div />
      <div data-bench className="flex flex-col items-start gap-3">
        {children}
      </div>
    </main>
  );
}
