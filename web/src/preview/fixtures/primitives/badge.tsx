import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Badge bench: `.badge` and its tones and sizes, `.dot`, `.badge-x`, `.nav-badge`.
 *
 * A stub until pass 2's P1b (actions) draws that legacy markup beside `<Badge>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const badgeStates: Record<string, PrimitiveState> = {
  badge: () => <Columns legacy="stub" next="stub" />,
};
