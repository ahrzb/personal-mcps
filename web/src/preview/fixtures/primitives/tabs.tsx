import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Tabs bench: `.segmented` as /audit's view switch.
 *
 * A stub until pass 2's P1b (overlays) draws that legacy markup beside `<Tabs>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const tabsStates: Record<string, PrimitiveState> = {
  tabs: () => <Columns legacy="stub" next="stub" />,
};
