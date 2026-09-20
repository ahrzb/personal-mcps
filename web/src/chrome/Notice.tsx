import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useDropSearchKeys } from "./Confirm";
import { alertClass } from "@/lib/format";
import { hasNotice, NOTICE_KEYS, noticeOf } from "@/lib/notice";
import type { Notice } from "@/lib/notice";
import type { NoticeTone } from "@/lib/format";

/**
 * The flash banner, ported from `pages/apps.tsx:218-229` — and rendered by the PAGE, inside
 * its own `<main>` above `.page-head`, exactly where the server-rendered pages rendered it.
 *
 * Not by the shell, deliberately: `styles.css` positions `.alert` as the first child of the
 * page's `<main>`, so a banner hoisted into the chrome would sit outside the page's gutters
 * and above its title. The shell owns the header; the page owns its own first line.
 */
export function NoticeBanner({ notice }: { notice: Notice }): ReactNode {
  return (
    <div className={alertClass(notice.tone)} role={notice.tone === "danger" ? "alert" : "status"}>
      <NoticeIcon tone={notice.tone} />
      <div>
        {notice.title === undefined ? null : <div className="alert-title">{notice.title}</div>}
        <div className="alert-text">{notice.message}</div>
      </div>
    </div>
  );
}

/**
 * The flash a retained server redirect left, consumed.
 *
 * Read on EVERY search change rather than only at first mount, because the three redirects
 * the Worker still performs can land on a route the client is already showing — `POST
 * /apps/connect`'s refusal arm and the upstream OAuth callback both do.
 *
 * LATCHED, because the two halves of "consumed" fight otherwise: the keys are stripped by a
 * replacing navigation — a notice is not a place Back should return to, and a reload must
 * not re-announce a change that already happened — and that navigation is what would
 * otherwise unmount the banner in the same frame it appeared, leaving every server-redirect
 * notice invisible. So the notice is held in state and the URL loses its keys.
 *
 * Held by IDENTITY rather than by first value: a second flash arriving later replaces the
 * one on screen, and a repeat of the same one neither loops nor re-announces.
 */
export function useFlash(search: Record<string, unknown>): Notice | null {
  const drop = useDropSearchKeys();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === "string") params.set(key, value);
  }
  const arriving = noticeOf(params);
  const identity = hasNotice(params) ? params.toString() : "";
  const [held, setHeld] = useState<Notice | null>(arriving);
  useEffect(() => {
    if (identity === "") return;
    setHeld(arriving);
    drop(Object.values(NOTICE_KEYS));
    // `arriving` and `drop` both close over the current location and are therefore
    // deliberately NOT dependencies: re-running on their identity would strip the keys a
    // second time after the navigation that already removed them.
  }, [identity]);
  // Whichever is authoritative: the URL while it still carries the flash, the held copy
  // once the strip has taken the keys off it.
  return identity === "" ? held : arriving;
}

/** Tone-appropriate glyph — danger, warning, then success; `stroke="currentColor"` so it
 *  always matches the alert's own text colour. */
function NoticeIcon({ tone }: { tone: NoticeTone }): ReactNode {
  if (tone === "danger") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10" />
        <path d="m15 9-6 6" />
        <path d="m9 9 6 6" />
      </svg>
    );
  }
  if (tone === "warning") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 20h16a2 2 0 0 0 1.73-2Z" />
        <path d="M12 9v4" />
        <path d="M12 17h.01" />
      </svg>
    );
  }
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  );
}
