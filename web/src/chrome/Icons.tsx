import type { ReactNode } from "react";

/**
 * The hand-drawn glyphs more than one page draws, each once. Decoration beside words that
 * already say what the control does, so none is read out.
 */

/** The plus that leads an "add" control — /apps' Add app, /settings' Add passkey. 14px, in the
 *  text colour. */
export function PlusIcon(): ReactNode {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </svg>
  );
}

/** The key glyph that marks a passkey — /login's "Sign in with a passkey" and each passkey
 *  row in /settings. 16px, in the text colour unless `className` says otherwise. */
export function PasskeyIcon({ className }: { className?: string }): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <circle cx="7.5" cy="15.5" r="3.5" />
      <path d="m21 2-9.6 9.6" />
      <path d="m15.5 7.5 3 3L22 7l-3-3" />
    </svg>
  );
}
