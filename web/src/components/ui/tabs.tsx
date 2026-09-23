import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva } from "class-variance-authority"
import { cn } from "@/lib/cn"

/**
 * The segmented strip that switches between views of one page (legacy `.segmented`): a muted
 * track holding its arms, the current one raised in white. Tabs for in-page views, /audit's
 * Summary · Sessions · Events. /settings' token-kind row looks the same but is URL navigation,
 * links with `aria-current` rather than tabs (pass 2 ruling 1.5), so it borrows the two class
 * strings below instead of these roles.
 */

function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

/** The track. A block-level flex row, as `.segmented` was: content-wide where its container
 *  shrinks it, and full width where one stretches it (/audit's header at the narrow
 *  breakpoint). */
const tabsListVariants = cva("flex items-center gap-0.5 rounded-md bg-muted p-0.5")

/**
 * One arm: 32px, or 44px and growing into the free width at the narrow breakpoint. The
 * current arm is `aria-selected` on a Tab and `aria-current="page"` on a borrowed link.
 *
 * A focused arm, the current one included, shows the 35% ring in place of any raised shadow.
 * The current arm's `…:focus-visible:shadow-none` is stacked on its state because a bare
 * `focus-visible:` utility is output before `aria-*` ones and would lose to its `shadow-xs`.
 */
const tabsTriggerVariants = cva(
  "flex h-control-sm cursor-pointer items-center justify-center rounded-sm px-3 text-sm font-medium text-muted-foreground no-underline focus-visible:ring-3 focus-visible:ring-ring/35 focus-visible:outline-none aria-selected:bg-background aria-selected:text-foreground aria-selected:shadow-xs aria-selected:focus-visible:shadow-none aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-xs aria-[current=page]:focus-visible:shadow-none max-md:h-control-touch max-md:grow max-md:text-base"
)

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(tabsListVariants(), className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(tabsTriggerVariants(), className)}
      {...props}
    />
  )
}

/** A view's body. It sets no type of its own: the page it holds does. */
function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 outline-none", className)}
      {...props}
    />
  )
}

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  tabsListVariants,
  tabsTriggerVariants,
}
