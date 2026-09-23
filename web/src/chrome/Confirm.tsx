import { Dialog } from "@base-ui/react/dialog";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";

/**
 * §13's confirm step. URL-ADDRESSED, exactly as the server-rendered one was: the dialog is
 * open because the route's `?confirm=` says so, and closing it is a navigation that drops the
 * key. That is not nostalgia for the old mechanism — it is the property the old one had and
 * this one must keep, because a confirm URL is shareable, bookmarkable, and is how the
 * preview gallery shows the state at all.
 *
 * It renders a NATIVE `<dialog>` and opens it with `showModal()`.
 *
 * That combination is deliberate and was arrived at by comparing screenshots. Base UI's
 * Dialog supplies the behaviour the server-rendered page could not — a focus trap, Escape to
 * close, `aria-modal` wiring — while the element keeps `styles.css`'s `dialog` and
 * `dialog::backdrop` rules, which are the whole of a confirmation's appearance, and the
 * platform's own `dialog:modal` centring. Base UI's default `<div>` popup matched none of
 * those selectors: it rendered unstyled at the foot of the document with no scrim, and
 * reproducing the box in `app.css` would have been a second definition of a design element
 * the shared sheet already owns.
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
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Popup render={<ModalDialog />}>
          <div className="dialog-body">
            <div>
              {/* `render={<div />}` on both: Base UI's defaults are an `<h2>` and a `<p>`,
                  and `styles.css:130-140` gives every `h1,h2,h3` `line-height: 1.2` where a
                  div inherits the body's 1.55. A heading is therefore NOT the box
                  `.dialog-title` describes, and the sheet that says so is every page's
                  design language — so the primitive stops matching the
                  base-element selector rather than fighting it with a counter-rule. */}
              <Dialog.Title render={<div />} className="dialog-title">
                {title}
              </Dialog.Title>
              <Dialog.Description render={<div />} className="dialog-text">
                {text}
              </Dialog.Description>
            </div>
            {children}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The `<dialog>` element itself, opened modally as soon as it is in the document.
 *
 * `showModal()` rather than the `open` attribute: only the modal form gets the UA's centring
 * and a `::backdrop` at all — an `open` attribute produces a left-aligned box and no scrim,
 * which is exactly why the server-rendered page shipped a re-open script beside its
 * `<dialog open>`. Props arrive from Base UI's `render` and are spread, so its ARIA wiring
 * and its own ref are preserved.
 */
function ModalDialog(props: React.ComponentProps<"dialog">): ReactNode {
  const own = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const element = own.current;
    if (element !== null && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      {...props}
      ref={(element) => {
        own.current = element;
        const forwarded = (props as { ref?: React.Ref<HTMLDialogElement> }).ref;
        if (typeof forwarded === "function") forwarded(element);
        else if (forwarded !== null && forwarded !== undefined) forwarded.current = element;
      }}
    />
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
