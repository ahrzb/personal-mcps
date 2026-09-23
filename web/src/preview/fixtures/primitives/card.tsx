import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Card bench: `.card` and its parts, `.auth-card`.
 *
 * A stub until pass 2's P1b (surfaces) draws that legacy markup beside `<Card>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const cardStates: Record<string, PrimitiveState> = {
  card: () => <Columns legacy="stub" next="stub" />,
};
