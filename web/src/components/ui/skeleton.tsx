import * as React from "react"
import { cn } from "@/lib/cn"

/**
 * A pulsing grey block standing in for content still being read. 6px corners (`rounded-sm`),
 * the radius the loading rows have always had; the caller sizes it.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-sm bg-muted", className)}
      {...props}
    />
  )
}

export { Skeleton }
