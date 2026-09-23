import type { PrimitiveState } from "../../seed";
import { Columns } from "./Columns";

/**
 * The Sheet bench: the drawer `.menu`, `.audit-drawer`, `.audit-level`.
 *
 * A stub until pass 2's P1b (overlays) draws that legacy markup beside `<Sheet>` in every
 * variant, size and state; its one state compares a placeholder with itself.
 */
export const sheetStates: Record<string, PrimitiveState> = {
  sheet: () => <Columns legacy="stub" next="stub" />,
};
