import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Columns } from "./Columns";

/**
 * The Empty bench: `.empty` on its own (titled, with a button under it) and `.empty--inline`
 * inside a card (text alone, and titled), each beside `<Empty>`.
 */
export const emptyStates: Record<string, PrimitiveState> = {
  empty: () => (
    <Columns
      legacy={
        <>
          <Full>
            <div className="empty">
              <div className="empty-title">No agents yet.</div>
              <div className="empty-text">Create one to give an AI agent its own grants and keys.</div>
            </div>
          </Full>
          <Full>
            <div className="empty">
              <div className="empty-title">Couldn&apos;t load the audit log</div>
              <div className="empty-text">The hub did not answer. Nothing was changed.</div>
              <button type="button" className="btn btn--outline">
                Try again
              </button>
            </div>
          </Full>
        </>
      }
      next={
        <>
          <Full>
            <Empty>
              <EmptyTitle>No agents yet.</EmptyTitle>
              <EmptyDescription>Create one to give an AI agent its own grants and keys.</EmptyDescription>
            </Empty>
          </Full>
          <Full>
            <Empty>
              <EmptyTitle>Couldn&apos;t load the audit log</EmptyTitle>
              <EmptyDescription>The hub did not answer. Nothing was changed.</EmptyDescription>
              <button type="button" className="btn btn--outline mt-4">
                Try again
              </button>
            </Empty>
          </Full>
        </>
      }
    />
  ),

  // Inside the card that is already the box: /settings' tokens card (text alone) and /audit's
  // "Nothing matches" (titled).
  "empty-inline": () => (
    <Columns
      legacy={
        <>
          <Full>
            <div className="card">
              <div className="empty empty--inline">
                <div className="empty-text">A client that completes the consent screen appears here.</div>
              </div>
            </div>
          </Full>
          <Full>
            <div className="card">
              <div className="empty empty--inline">
                <div className="empty-title">Nothing matches</div>
                <div className="empty-text">Widen the window or drop a filter.</div>
              </div>
            </div>
          </Full>
        </>
      }
      next={
        <>
          <Full>
            <Card size="flush">
              <Empty variant="inline">
                <EmptyDescription>A client that completes the consent screen appears here.</EmptyDescription>
              </Empty>
            </Card>
          </Full>
          <Full>
            <Card size="flush">
              <Empty variant="inline">
                <EmptyTitle>Nothing matches</EmptyTitle>
                <EmptyDescription>Widen the window or drop a filter.</EmptyDescription>
              </Empty>
            </Card>
          </Full>
        </>
      }
    />
  ),
};

/** An empty state fills its column on a page. */
function Full({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full">{children}</div>;
}
