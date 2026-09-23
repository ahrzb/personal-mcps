import type { PrimitiveState } from "../../seed";
import { Skeleton } from "@/components/ui/skeleton";
import { Bench } from "./Bench";

/**
 * The Skeleton bench: `chrome/States`' loading rows and /audit's still bars, each a
 * `<Skeleton>`.
 *
 * The rows pulse, and the compare shoots them wherever the pulse is: two shots differ by a
 * few dozen pixels, too faint for the compare's per-pixel tolerance to see. The bars sit 20px
 * down, where the audit page's own padding put them.
 */
export const skeletonStates: Record<string, PrimitiveState> = {
  skeleton: () => (
    <Bench>
      <div className="flex w-full flex-col gap-2" aria-busy="true">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-9" />
        ))}
      </div>
      <div className="w-full pt-5">
        <Skeleton className={A_SKEL} style={{ width: "70%" }} />
        <Skeleton className={`${A_SKEL} mt-1.5`} style={{ width: "52%" }} />
      </div>
    </Bench>
  ),
};

/** /audit's bar: a still 12px bar shaded muted → bar → muted. The gradient is written out,
 *  since Tailwind's gradient utilities interpolate in oklab. */
const A_SKEL =
  "h-3 animate-none bg-[linear-gradient(90deg,var(--color-muted),var(--color-a-bar),var(--color-muted))]";
