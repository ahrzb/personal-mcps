import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback } from "react";
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * §13's confirm step. URL-ADDRESSED, exactly as the server-rendered one was: the dialog is
 * open because the route's `?confirm=` says so, and closing it is a navigation that drops the
 * key. That is not nostalgia for the old mechanism — it is the property the old one had and
 * this one must keep, because a confirm URL is shareable, bookmarkable, and is how the
 * preview gallery shows the state at all.
 *
 * The box is `components/ui/dialog`, which draws what the native `<dialog>` drew (its width,
 * edge, scrim and centring); Base UI supplies the focus trap, Escape and `aria-modal`.
 */
export function ConfirmDialog({
  title,
  text,
  children,
  onClose,
}: {
  title: string;
  text: string;
  /** The actions — the caller's, because everything else about a confirmation is the same
   *  question asked about a different row. */
  children: ReactNode;
  /** Called when the dialog is dismissed. The caller navigates the `?confirm=` key away, so
   *  the URL and what is on screen cannot disagree. */
  onClose: () => void;
}): ReactNode {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {/* `[&_.actions]:gap-2` stands in for legacy.css's `dialog .actions { gap: 8px }`, which
          keyed on the native element this box no longer is: every caller still wraps its
          actions in a legacy `.actions` row (12px apart elsewhere). It goes when the last
          caller passes a `DialogFooter` instead, in its family's pass-2 conversion. */}
      <DialogContent className="[&_.actions]:gap-2">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{text}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Dropping one search key by a REPLACING navigation — what closing a URL-addressed dialog
 * does, and what the flash reader does once it has shown a notice.
 *
 * Replacing rather than pushing, in both cases for the same reason: neither the dialog you
 * just dismissed nor the notice you just read is a place Back should return to.
 */
export function useDropSearchKeys(): (keys: readonly string[]) => void {
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location });
  return useCallback(
    (keys) => {
      const search = { ...(location.search as Record<string, unknown>) };
      let touched = false;
      for (const key of keys) {
        if (key in search) {
          delete search[key];
          touched = true;
        }
      }
      if (!touched) return;
      void navigate({ to: location.pathname, search, replace: true });
    },
    [location.pathname, location.search, navigate],
  );
}
