import type { PrimitiveState } from "../../seed";
import { Skeleton } from "@/components/ui/skeleton";
import { Columns } from "./Columns";

/**
 * The Skeleton bench: `chrome/States`' loading rows and /audit's `.a-skel` bars, each beside
 * `<Skeleton>`.
 *
 * The rows pulse on both sides; the pulse is too faint for the compare's per-pixel tolerance
 * to see, so the two cells match whenever each is shot. The bars sit in `.audit` on both
 * sides, because their gradient reads that scope's `--a-bar`.
 */
export const skeletonStates: Record<string, PrimitiveState> = {
  skeleton: () => (
    <Columns
      legacy={
        <>
          <div className="flex w-full flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-9 animate-pulse rounded-sm bg-muted" />
            ))}
          </div>
          <div className="audit w-full">
            <span className="a-skel" style={{ width: "70%", display: "block" }} />
            <span className="a-skel" style={{ width: "52%", display: "block", marginTop: 6 }} />
          </div>
        </>
      }
      next={
        <>
          <div className="flex w-full flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-9" />
            ))}
          </div>
          <div className="audit w-full">
            <Skeleton className={A_SKEL} style={{ width: "70%" }} />
            <Skeleton className={`${A_SKEL} mt-1.5`} style={{ width: "52%" }} />
          </div>
        </>
      }
    />
  ),
};

/** `.a-skel`: a still 12px bar shaded muted → bar → muted. The gradient is the legacy rule's
 *  literally, since Tailwind's gradient utilities interpolate in oklab. */
const A_SKEL =
  "h-3 animate-none bg-[linear-gradient(90deg,var(--color-muted),var(--color-a-bar),var(--color-muted))]";
