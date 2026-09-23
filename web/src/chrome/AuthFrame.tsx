import type { ReactNode } from "react";

/**
 * The chromeless frame of the pages a person reaches before, or outside, the signed-in shell
 * — sign-in, device approval, consent, one approval, adding an app (legacy.css's `.auth`,
 * `.brand`, `.auth-foot`): the brand, then `children` (one `Card size="auth"`, whose
 * `CardTitle` and `CardDescription` are `.auth-title` and `.auth-desc`), then `foot`, all
 * centred on the sunken ground a screen tall. On a phone the ground goes white and the card
 * loses its edge (`Card`'s own `auth` size), so the page reads as one sheet.
 */
export function AuthFrame({
  foot,
  children,
}: {
  /** The small centred line under the card — a way back, a reminder — at the card's width.
   *  Omitted, there is none. */
  foot?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div
      data-slot="auth-frame"
      className="flex min-h-screen flex-col items-center justify-center gap-6 bg-sunken px-5 py-8 max-md:bg-background"
    >
      <div className="flex shrink-0 items-center gap-2 text-md font-semibold max-md:text-lg">
        <BrandMark />
        <span>personal-mcps</span>
      </div>
      {children}
      {foot === undefined ? null : (
        <div className="w-auth max-w-full text-center text-xs leading-normal text-muted-foreground">{foot}</div>
      )}
    </div>
  );
}

/** The hub mark from the artboards — a node with three spokes, 20px in the text colour. Also
 *  `Shell`'s, in the header and the drawer. */
export function BrandMark(): ReactNode {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 8.5V3.5" />
      <path d="M14.5 14.5L18.5 18.5" />
      <path d="M9.5 14.5L5.5 18.5" />
    </svg>
  );
}
