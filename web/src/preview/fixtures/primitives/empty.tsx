import type { ReactNode } from "react";
import type { PrimitiveState } from "../../seed";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyTitle } from "@/components/ui/empty";
import { Bench } from "./Bench";

/**
 * The Empty bench: `<Empty>` on its own (titled, with a button under it), and inline inside a
 * card (text alone, and titled).
 */
export const emptyStates: Record<string, PrimitiveState> = {
  empty: () => (
    <Bench>
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
          <Button variant="outline" className="mt-4">
            Try again
          </Button>
        </Empty>
      </Full>
    </Bench>
  ),

  // Inside the card that is already the box: /settings' tokens card (text alone) and /audit's
  // "Nothing matches" (titled).
  "empty-inline": () => (
    <Bench>
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
    </Bench>
  ),
};

/** An empty state fills its column on a page. */
function Full({ children }: { children: ReactNode }): ReactNode {
  return <div className="w-full">{children}</div>;
}
