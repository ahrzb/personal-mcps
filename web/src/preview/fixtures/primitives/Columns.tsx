import type { ReactNode } from "react";

/**
 * The frame every `primitives` state draws: the legacy markup, and the generated component that
 * replaces it, side by side at one width.
 *
 * THE TWO-COLUMN CONTRACT, which `scripts/visual-compare.mts` crops by. A state renders exactly
 * one `<Columns>`:
 *
 *  - `legacy` is today's markup, the legacy.css classes exactly as the pages write them;
 *  - `next` is the same thing drawn by the component, in the same order, with the same wrappers.
 *
 * Each side lands in its own cell, `[data-column="legacy"]` and `[data-column="next"]`, of
 * identical width, and both stretch to the row's height. The compare screenshots the two cells
 * and requires them pixel-identical (budget 0, under the page compare's per-pixel tolerance), so
 * a `next` that is taller, wider, shifted or recoloured fails, and any caption that must differ
 * between the sides belongs outside the cells, where the two headings are.
 */
export function Columns({ legacy, next }: { legacy: ReactNode; next: ReactNode }): ReactNode {
  return (
    <main className="grid grid-cols-2 gap-x-4 gap-y-2 p-4">
      <p className="muted">legacy</p>
      <p className="muted">component</p>
      <div data-column="legacy" className="flex flex-col items-start gap-3">
        {legacy}
      </div>
      <div data-column="next" className="flex flex-col items-start gap-3">
        {next}
      </div>
    </main>
  );
}
