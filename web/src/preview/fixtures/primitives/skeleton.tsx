import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Skeleton bench: `.a-skel`, States.Skeleton.
 *
 * A stub until pass 2's P1b (surfaces) draws that legacy markup beside `<Skeleton>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const skeletonStates: Record<string, PrimitiveState> = {
  skeleton: () => <Columns legacy="stub" next="stub" />,
};
