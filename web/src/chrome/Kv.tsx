import { createContext, useContext } from "react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * Key/value pairs: a key column of one width, so a stack of values lines up (legacy.css's
 * `.kv`, `.kv-row`, `.kv-key`). Two shapes, chosen by the `KvList` around the pairs:
 *
 *  - `details` (the default): the details column's LINES (legacy.css's `.db .kv`) — 12px, a
 *    110px key, the value beside it on its baseline and breaking anywhere. Below 1024px on a
 *    page with levels each pair stacks, key above value.
 *  - `block`: the grey block of the approval, consent and device pages and the app page's
 *    panes (`.kv` on its own) — 13px, a 180px key, the value pushed to the far edge. Inside an
 *    `auth` card the key takes its natural width and the value breaks anywhere, because a
 *    phone leaves a 180px key column no room (consent's and device's values are chosen by
 *    whoever registered the client).
 *
 * `details` is the default because a `Kv` with no list around it is the agent page's details
 * row, which is where every pair outside the block lives.
 */
export function KvList({
  variant = "details",
  className,
  ...props
}: ComponentProps<"div"> & { variant?: KvVariant }): ReactNode {
  return (
    <KvContext.Provider value={variant}>
      <div
        data-slot="kv"
        className={cn("flex flex-col gap-2", variant === "block" && "rounded-md bg-muted px-3.5 py-3", className)}
        {...props}
      />
    </KvContext.Provider>
  );
}

/** One pair: `k` in the key column, `children` the value. Its shape is its `KvList`'s. */
export function Kv({ k, children }: { k: ReactNode; children?: ReactNode }): ReactNode {
  const shape = SHAPES[useContext(KvContext)];
  return (
    <div data-slot="kv-row" className={shape.row}>
      <div className={shape.key}>{k}</div>
      <div className={shape.value}>{children}</div>
    </div>
  );
}

/** The two shapes a list of pairs takes; `KvList` says which. */
export type KvVariant = "details" | "block";

/** The enclosing list's shape. Context rather than a CSS ancestor rule, so each shape is one
 *  set of classes and a pair never has to undo the other's. */
const KvContext = createContext<KvVariant>("details");

const SHAPES: Record<KvVariant, { row: string; key: string; value: string }> = {
  details: {
    row: "flex items-baseline gap-3 text-xs [[data-level]_&]:max-lg:flex-col [[data-level]_&]:max-lg:items-start [[data-level]_&]:max-lg:gap-0.5",
    key: "w-kv-key-dense shrink-0 text-muted-foreground [[data-level]_&]:max-lg:w-auto",
    value: "min-w-0 wrap-anywhere",
  },
  block: {
    row: "flex items-center justify-between gap-3 text-sm",
    key: "w-kv-key shrink-0 text-muted-foreground group-data-[size=auth]/card:w-auto",
    value: "group-data-[size=auth]/card:min-w-0 group-data-[size=auth]/card:wrap-anywhere",
  },
};
