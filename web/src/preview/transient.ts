import { createContext, useContext } from "react";
import type { TotpEnrollment, Violation } from "@/lib/types";

/**
 * The state gallery's one seam into the pages, and the reason it needs one.
 *
 * Most of what `server/dev/fixtures.ts` shows is reachable without a seam: a query result is
 * seeded into the cache, and an open dialog or a selected row is a search parameter. Some
 * states are neither — they are the transient result of a submit that the gallery cannot
 * perform and no resource returns:
 *
 *  - a minted key, which is shown exactly once and deliberately never cached (§4/§15);
 *  - a refused save's field-scoped violations, drawn against the editor's local draft;
 *  - the create receipt;
 *  - §13's connecting screen, whose authorize URL comes from a single-use state row;
 *  - /settings' TOTP enrolment and backup codes, shown once for the same reason as a key.
 *
 * Two more arms (`recordSearch`, `openRun`) are typed-in or reading-position state, each
 * saying below why it is not in the URL.
 *
 * So each owning component reads this context for its INITIAL value and is otherwise
 * unchanged. In production the context is empty and every arm reads as absent, which is the
 * same code path a first render takes anyway — there is no preview branch inside a page.
 */
export type Transient = {
  /**
   * A freshly minted key, as the Token / Credentials pane would hold it.
   *
   * The ROW ID rides with the plaintext because the pane draws two things from one mint:
   * the reveal, and the `new` badge on the row it belongs to. A seed carrying only the
   * secret could show the first and not the second, which is a different screen from the
   * one the mint actually produces.
   */
  revealedToken?: { token: string; id: string };
  /** A refused write, as a mutation's `ApiError` would have surfaced it. */
  refusal?: { reason: string; violations?: Violation[] };
  /** The add-app flow's receipt: a created app, with its once-only token where there is one. */
  created?: { slug: string; name: string; token?: string | null };
  /** §13's connecting screen, mid-flow. */
  connecting?: { slug: string; name: string; authorizeUrl: string };
  /**
   * What the audit record's **Search this record…** box holds.
   *
   * A fifth arm, and it earns one the same way the four above do: it is typed into a box, so no
   * resource returns it, and it is NOT in the URL — the record search filters what is drawn
   * inside one open record rather than what the page selected, and putting it in the query
   * string would make it survive closing the drawer. Without this the gallery cannot show the
   * one state where a search opens a collapsed subtree.
   */
  recordSearch?: string;
  /**
   * The ×N run the Events view has UNFOLDED, by its head row's id.
   *
   * Which runs are open is reading position — where somebody got to inside one row — so it is
   * component state rather than URL state, and a seed has no other way to reach it. The board
   * has to draw a collapsed row's expanded form: "how do I see what is inside" is part of that
   * row's contract, and the one time it was not drawn the members turned out to be unreachable
   * (postmortem 2026-09-21).
   */
  openRun?: number;
  /**
   * /settings' two-factor reveals. Both are the answer to a POST that is shown once and never
   * cached — `enrollment` the in-flight TOTP secret and its QR, `backupCodes` the ten codes an
   * enable or a regenerate mints (§4/§15) — so, like `revealedToken`, a seed has no other way
   * to draw them.
   */
  enrollment?: TotpEnrollment;
  backupCodes?: string[];
  /** What the owner typed into the Execution pane before a refused Save — kept on screen
   *  beside the op's sentence (`refusal`), which is the whole point of that state. */
  executionDraft?: { defaults: string; maximum: string };
};

const TransientContext = createContext<Transient>({});

export const TransientProvider = TransientContext.Provider;

/** What the gallery seeded for this render, or nothing. Safe to call anywhere: the default
 *  is the empty object, so a page outside the gallery sees exactly what a fresh mount sees. */
export function usePreviewTransient(): Transient {
  return useContext(TransientContext);
}
