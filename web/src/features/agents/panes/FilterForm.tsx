import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type { ReactNode } from "react";

/**
 * A listing's filter, as both panes that have one draw it: a form of its OWN, whose submit is
 * a navigation.
 *
 * It stayed a form rather than becoming a keystroke handler for two reasons the server's
 * version had too. The typed text is the page's `?q=`, so a filtered listing is a URL
 * somebody can share — and on the grant step it also decides which apps' catalogs are read,
 * so a keystroke-driven filter would issue a round trip per character and push a history
 * entry for each.
 *
 * `keep` is whatever the pane's URL must not lose when the filter changes (`?show=` on the
 * grant step, `?sel=` nowhere — picking a row and filtering the list are different acts and
 * the server dropped `sel` here too).
 */
export function FilterForm({
  to,
  keep,
  q,
  placeholder,
  label,
}: {
  to: string;
  keep: Record<string, string>;
  /** The filter the URL currently carries — the draft's starting point. */
  q: string;
  placeholder: string;
  /** The accessible name; the two panes label their filter differently. */
  label: string;
}): ReactNode {
  const navigate = useNavigate();
  // A draft, not a mirror: the input holds what the owner is typing, and the URL holds what
  // they submitted. Seeded once — a `?q=` that changes under an open pane is the result of
  // this very submit.
  const [typed, setTyped] = useState(q);
  return (
    <form
      className="lh-filter"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = typed.trim();
        void navigate({ to, search: { ...keep, ...(trimmed === "" ? {} : { q: trimmed }) } });
      }}
    >
      <input
        type="search"
        name="q"
        value={typed}
        placeholder={placeholder}
        aria-label={label}
        onChange={(event) => setTyped(event.target.value)}
      />
    </form>
  );
}
