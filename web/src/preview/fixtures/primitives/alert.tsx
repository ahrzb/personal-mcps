import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Alert bench: `.alert` and its tones, `.a-ceiling`.
 *
 * A stub until pass 2's P1b (surfaces) draws that legacy markup beside `<Alert>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const alertStates: Record<string, PrimitiveState> = {
  alert: () => <Columns legacy="stub" next="stub" />,
};
