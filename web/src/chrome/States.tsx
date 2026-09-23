import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ApiError } from "@/lib/http";

/**
 * The five states every read on every pane renders, in one place so no pane invents a sixth
 * or collapses two into one.
 *
 * The distinction this component exists to keep is UNREAD versus EMPTY. A catalog that could
 * not be read is a 503 carrying `unread`, and it draws a marker that is neither `0` nor
 * `—`; an empty one draws the artboards' empty copy. `gateway.ownerCatalog` exists to keep
 * those two answers apart on the wire, and a client that rendered both as "nothing here"
 * would throw that away at the last step.
 */
export function QueryState<T>({
  query,
  /** What a skeleton stands in for, so a loading pane is not a blank rectangle. */
  skeleton,
  /** Drawn when the read succeeded but there is nothing in it. Omit where the pane's own
   *  body already says so. */
  empty,
  /** Drawn for a 503 `unread`. Omit on a pane whose read cannot be unread. */
  unread,
  children,
}: {
  query: UseQueryResult<T>;
  skeleton?: ReactNode;
  empty?: { when: (data: T) => boolean; render: ReactNode };
  unread?: ReactNode;
  children: (data: T) => ReactNode;
}): ReactNode {
  if (query.isPending) return skeleton ?? <Skeleton rows={3} />;
  if (query.isError) {
    const error = query.error;
    if (unread !== undefined && error instanceof ApiError && error.unread) return unread;
    return <Failure message={error.message} onRetry={() => void query.refetch()} />;
  }
  const data = query.data as T;
  if (empty !== undefined && empty.when(data)) return empty.render;
  return children(data);
}

/**
 * A read in flight where there is nothing yet to show. Rows rather than a spinner: the
 * shapes below are tables and lists, and a block of the right height stops the pane from
 * jumping when the answer lands.
 *
 * The one place this client draws with Tailwind utilities rather than `styles.css` classes,
 * because the loading state is NEW: the server-rendered pages had none — they blocked the
 * document on their reads — so there is no existing class to reuse and inventing one would
 * mean editing the sheet every page shares.
 *
 * `rounded-sm` is 6px, the radius these rows were drawn with when `rounded-md` still meant
 * Tailwind's 6px; the theme's `rounded-md` is a control's 8px since pass 2's P1a.
 */
export function Skeleton({ rows }: { rows: number }): ReactNode {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="h-9 animate-pulse rounded-sm bg-muted" />
      ))}
    </div>
  );
}

/** A read that failed for a reason the owner can retry. */
export function Failure({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return (
    <div className="alert alert--danger" role="status">
      {message}{" "}
      <button type="button" className="btn btn--outline btn--sm" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/**
 * The quiet indicator a pane header shows while a REFETCH is in flight and the previous
 * answer is still on screen — the state `isPending` is not, and the one that would otherwise
 * be invisible: a background refresh that replaces a table under the reader with no sign
 * that anything happened.
 */
export function Refreshing({ active }: { active: boolean }): ReactNode {
  return active ? (
    <span className="muted" aria-live="polite">
      refreshing…
    </span>
  ) : null;
}
