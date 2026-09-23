import { useState } from "react";
import type { CSSProperties, ReactNode } from "react";

/**
 * An overlay drawn OPEN inside the `Bench` cell, so the crop holds it. The overlays' benches
 * (dialog, sheet) draw through one of these.
 *
 * Dialog and Sheet are `position: fixed`, laid out against the viewport, which would put them
 * outside the cell the compare crops. A `transform` makes a box the containing block of its
 * fixed descendants, so the inner box here stands in for the screen: an overlay portalled into
 * it (through its `container`) lays out against that box as it would against the page, scrim
 * and all, and the cell-wide window around it clips
 * whatever falls outside. `vw` units still read the real viewport, which keeps a sheet's `85vw`
 * or `100vw` cap and the dialog's `100vw - 40px` today's.
 *
 * `viewport` places that stand-in inside the window: `inset: 0` (the default) makes it the
 * window itself. A right-hand sheet widens it past the window's right edge so the sheet's LEFT
 * edge, its shadow and its scrim land in view; a full-screen level insets it so the level's
 * shadow has room to show.
 *
 * `children` renders once the stand-in is in the document, with it as the portal container.
 */
export function OverlayStage({
  height,
  viewport,
  children,
}: {
  /** The window's height in px; its width is the cell's. */
  height: number;
  viewport?: CSSProperties;
  children: (container: HTMLElement) => ReactNode;
}): ReactNode {
  const [screen, setScreen] = useState<HTMLElement | null>(null);
  return (
    <div className="relative w-full overflow-hidden" style={{ height }}>
      <div ref={setScreen} style={{ position: "absolute", inset: 0, transform: "translate(0)", ...viewport }}>
        {screen === null ? null : children(screen)}
      </div>
    </div>
  );
}
